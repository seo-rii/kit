import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import MagicString from 'magic-string';
import { walk } from '../../../utils/filesystem.js';
import { posixify } from '../../../utils/os.js';
import { ts } from '../ts.js';
import { write } from '../utils.js';

/** @type {Map<string, Set<string>>} */
const dependencies = new Map();
/** @type {Map<string, Set<string>>} */
const missing_directories = new Map();

/**
 * The app imports declarations inferred in the worker program, never worker implementations.
 * Hashing the original filename also handles dependencies outside the project root.
 * @param {import('types').ValidatedConfig} config
 * @param {string} file
 * @param {string} root
 */
export function worker_declaration(config, file, root) {
	const id = createHash('sha256').update(path.resolve(root, file)).digest('hex').slice(0, 24);
	return path.resolve(root, config.kit.outDir, 'worker-types', `${id}.d.ts`);
}

/** @param {string} root @param {string} file */
export function is_worker_type_dependency(root, file) {
	const resolved = path.resolve(root, file);
	return (
		(dependencies.get(root)?.has(resolved) ?? false) ||
		[...(missing_directories.get(root) ?? [])].some((directory) =>
			resolved.startsWith(directory + path.sep)
		)
	);
}

/**
 * Emit a closed declaration graph in a WebWorker-only program. Copy local declaration
 * dependencies as well: a parameter's $worker-types import must not lead the app back
 * to the implementation used to infer that type.
 * @param {import('types').ValidatedConfig} config
 * @param {import('types').ManifestData} manifest
 * @param {string} root
 */
export function write_worker_declarations(config, manifest, root) {
	if (!ts) return;
	const directory = path.resolve(root, config.kit.outDir, 'worker-types');
	const workers = manifest.nodes.flatMap((node) =>
		node.worker ? [path.resolve(root, node.worker)] : []
	);
	if (!workers.length) {
		dependencies.delete(root);
		missing_directories.delete(root);
		fs.rmSync(directory, { recursive: true, force: true });
		return;
	}

	/** @type {Set<string>} */
	const inputs = new Set(workers);
	/** @type {Set<string>} */
	const missing = new Set();
	/** @param {string[]} candidates */
	const read_config = (candidates) => {
		const file = candidates.find((file) => {
			inputs.add(path.resolve(file));
			return fs.existsSync(file);
		});
		return file
			? ts.getParsedCommandLineOfConfigFile(
					file,
					{},
					{
						...ts.sys,
						readFile(file) {
							inputs.add(path.resolve(file));
							return ts.sys.readFile(file);
						},
						fileExists(file) {
							inputs.add(path.resolve(file));
							return ts.sys.fileExists(file);
						},
						directoryExists(file) {
							const exists = ts.sys.directoryExists(file);
							if (!exists && !file.includes(`${path.sep}node_modules${path.sep}`)) {
								missing.add(path.resolve(file));
							}
							return exists;
						},
						onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
							throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
						}
					}
				)
			: undefined;
	};
	const parsed = read_config([
		path.resolve(root, config.kit.outDir, 'tsconfig.worker.json'),
		path.join(root, 'tsconfig.worker.json'),
		path.join(root, 'tsconfig.json')
	]);
	const types_directory = path.resolve(root, config.kit.outDir, 'types');
	const generated = walk(types_directory)
		.filter((file) => /(?:\$worker-types\.d\.ts|proxy\+(?:page|layout)\.worker\.[jt]s)$/.test(file))
		.map((file) => path.join(types_directory, file));
	/** @type {import('typescript').CompilerOptions} */
	const options = {
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		target: ts.ScriptTarget.ESNext,
		...parsed?.options,
		allowJs: true,
		checkJs: true,
		// Emitted data must preserve null/undefined for consumers using strict checking.
		strictNullChecks: true,
		lib: ['lib.esnext.d.ts', 'lib.webworker.d.ts'],
		rootDirs: [root, types_directory],
		rootDir: undefined,
		noEmit: false,
		noEmitOnError: false,
		declaration: true,
		emitDeclarationOnly: true,
		declarationMap: false,
		sourceMap: false,
		incremental: false,
		composite: false,
		outDir: path.join(directory, '.emit')
	};
	const host = ts.createCompilerHost(options, true);
	/** @param {import('typescript').FileReference} reference @param {string} file */
	const resolve_type_reference = (reference, file) =>
		ts.resolveTypeReferenceDirective(
			reference.fileName,
			file,
			options,
			host,
			undefined,
			undefined,
			reference.resolutionMode
		).resolvedTypeReferenceDirective?.resolvedFileName;
	const file_exists = host.fileExists;
	const directory_exists = host.directoryExists;
	/** @param {string} file */
	const local = (file) =>
		!file.includes(`${path.sep}node_modules${path.sep}`) &&
		!file.startsWith(path.resolve(config.kit.outDir) + path.sep);
	host.fileExists = (file) => {
		const exists = file_exists(file);
		if (!exists && local(file)) inputs.add(path.resolve(file));
		return exists;
	};
	host.directoryExists = (file) => {
		const exists = directory_exists?.(file) ?? false;
		if (!exists && local(file)) missing.add(path.resolve(file));
		return exists;
	};
	host.resolveModuleNameLiterals = (
		literals,
		containing_file,
		redirected,
		compiler_options,
		source
	) =>
		literals.map((literal) => {
			const result = ts.resolveModuleName(
				literal.text,
				containing_file,
				compiler_options,
				host,
				undefined,
				redirected,
				ts.getModeForUsageLocation(source, literal, compiler_options)
			);
			// Packages can expose TypeScript source instead of declarations. Treat those
			// implementations as emit inputs too, so their worker globals stay isolated.
			if (result.resolvedModule && !/\.d\.[cm]?ts$/.test(result.resolvedModule.resolvedFileName)) {
				result.resolvedModule.isExternalLibraryImport = false;
			}
			return result;
		});
	const worker_files = new Set([...workers, ...generated]);
	const roots = new Set([
		...worker_files,
		...(parsed?.fileNames.filter((file) => file.endsWith('.d.ts')) ?? [])
	]);
	let program = ts.createProgram({ rootNames: [...roots], options, host });
	while (true) {
		const external = program
			.getSourceFiles()
			.filter(
				(source) =>
					!source.isDeclarationFile &&
					program.isSourceFileFromExternalLibrary(source) &&
					!roots.has(source.fileName)
			);
		if (!external.length) break;
		for (const source of external) roots.add(source.fileName);
		// An implementation reached through a package declaration can still be marked
		// external by TypeScript. Explicit roots are needed to emit these declarations.
		program = ts.createProgram({ rootNames: [...roots], options, host, oldProgram: program });
	}

	/** @type {Map<string, string>} */
	const declarations = new Map();
	/** @type {Map<string, import('typescript').SourceFile>} */
	const sources = new Map();
	/** @type {Map<string, Set<string>>} */
	const references = new Map();
	/** @type {Set<string>} */
	const isolated = new Set();
	/** @type {Map<string, string>} */
	const reasons = new Map();
	/** @type {Map<string, Set<string>>} */
	const ambient_files = new Map();
	for (const source of program.getSourceFiles()) {
		if (source.isDeclarationFile && !ts.isExternalModule(source)) {
			for (const statement of source.statements) {
				if (ts.isModuleDeclaration(statement) && ts.isStringLiteral(statement.name)) {
					const files = ambient_files.get(statement.name.text) ?? new Set();
					files.add(path.resolve(source.fileName));
					ambient_files.set(statement.name.text, files);
				}
			}
		}
	}
	/** @param {string} name @param {import('typescript').ResolvedModuleFull | undefined} resolved */
	const resolve_ambient_module = (name, resolved) => {
		if (ambient_files.has(name)) return name;
		// Exact ambient names precede file resolution, while patterns are its fallback.
		if (resolved && program.getSourceFile(resolved.resolvedFileName)) return;
		let longest_prefix = -1;
		/** @type {string | undefined} */
		let match;
		for (const pattern of ambient_files.keys()) {
			const index = pattern.indexOf('*');
			if (index <= longest_prefix || pattern.indexOf('*', index + 1) !== -1) continue;
			const prefix = pattern.slice(0, index);
			const suffix = pattern.slice(index + 1);
			if (
				name.length >= prefix.length + suffix.length &&
				name.startsWith(prefix) &&
				name.endsWith(suffix)
			) {
				// Like TypeScript, keep the first match when prefixes have equal length.
				longest_prefix = index;
				match = pattern;
			}
		}
		return match;
	};
	/** @type {Set<string>} */
	const augmented_patterns = new Set();
	for (const source of program.getSourceFiles()) {
		if (program.isSourceFileDefaultLibrary(source)) continue;
		const file = path.resolve(source.fileName);
		if (file.startsWith(directory + path.sep)) continue;
		inputs.add(file);
		sources.set(file, source);
		if (
			worker_files.has(file) ||
			source.hasNoDefaultLib ||
			source.libReferenceDirectives.some((reference) =>
				/^webworker(?:\.|$)/i.test(reference.fileName)
			)
		) {
			isolated.add(file);
		}
		const imported = new Set(
			source.referencedFiles.map((reference) =>
				path.resolve(path.dirname(file), reference.fileName)
			)
		);
		for (const reference of source.typeReferenceDirectives) {
			const dependency = resolve_type_reference(reference, file);
			if (dependency) imported.add(path.resolve(dependency));
		}
		visit_imports(source, (literal) => {
			const resolved = ts.resolveModuleName(
				literal.text,
				file,
				options,
				host,
				undefined,
				undefined,
				program.getModeForUsageLocation(source, literal)
			).resolvedModule;
			const name = resolve_ambient_module(literal.text, resolved);
			const ambient = name && ambient_files.get(name);
			if (name?.includes('*') && ts.isModuleDeclaration(literal.parent)) {
				augmented_patterns.add(name);
			}
			if (ambient) {
				for (const file of ambient) imported.add(file);
			} else if (resolved) {
				imported.add(path.resolve(resolved.resolvedFileName));
			}
		});
		// A merged module has one identity. If any declaration needs isolation, all
		// contributions must move together, including ones without worker references.
		for (const files of ambient_files.values()) {
			if (files.has(file)) for (const dependency of files) imported.add(dependency);
		}
		references.set(file, imported);
	}
	const result = program.emit(
		undefined,
		(_file, text, _bom, _error, sources) => {
			const source = sources?.[0];
			if (source && inputs.has(path.resolve(source.fileName))) {
				declarations.set(path.resolve(source.fileName), text);
			}
		},
		undefined,
		true
	);
	if (result.emitSkipped || result.diagnostics.length) {
		throw new Error(
			`Unable to generate route worker declarations:\n${ts.formatDiagnostics(result.diagnostics, {
				getCanonicalFileName: (file) => file,
				getCurrentDirectory: () => root,
				getNewLine: () => '\n'
			})}`
		);
	}
	for (const [file, source] of sources) {
		if (!source.isDeclarationFile && !file.endsWith('.json') && !declarations.has(file)) {
			throw new Error(`Unable to generate a declaration for route worker dependency ${file}`);
		}
	}

	// Keep shared implementation types at their original identity too. A module is
	// shareable only if checking it in the app's environment is valid and infers the
	// same declarations. In particular, ordinary URL/String/Promise factories can
	// return brands without creating a second identity in the declaration snapshot.
	if ([...declarations.keys()].some((file) => !isolated.has(file))) {
		const app_config = read_config([
			path.join(root, 'tsconfig.json'),
			path.join(root, 'jsconfig.json'),
			path.join(root, config.kit.outDir, 'tsconfig.json')
		]);
		/** @param {import('typescript').CompilerOptions} options @param {string[]} roots */
		const create_app_program = (options, roots) => {
			const app_host = ts.createCompilerHost(options, true);
			const get_source_file = app_host.getSourceFile;
			app_host.getSourceFile = (file, language_version, ...args) => {
				// Referenced worker libraries must not make worker-only APIs appear valid
				// in this DOM-only eligibility check. The original worker program is intact.
				if (/[/\\]lib\.webworker(?:\.[^/\\]+)?\.d\.ts$/.test(file)) {
					return ts.createSourceFile(file, '', language_version, true);
				}
				const source = get_source_file(file, language_version, ...args);
				if (source) {
					source.libReferenceDirectives = source.libReferenceDirectives.filter(
						(reference) => !/^webworker(?:\.|$)/i.test(reference.fileName)
					);
					if (!file.startsWith(path.dirname(ts.getDefaultLibFilePath(options)) + path.sep)) {
						source.hasNoDefaultLib = false;
					}
				}
				return source;
			};
			app_host.resolveModuleNameLiterals = host.resolveModuleNameLiterals;
			return ts.createProgram({ rootNames: roots, options, host: app_host });
		};
		const app_program = create_app_program(
			{ ...options, lib: ['lib.esnext.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'] },
			[...roots]
		);
		/** @type {Map<string, string>} */
		const app_declarations = new Map();
		const app_result = app_program.emit(
			undefined,
			(_file, text, _bom, _error, sources) => {
				if (sources?.[0]) app_declarations.set(path.resolve(sources[0].fileName), text);
			},
			undefined,
			true
		);
		for (const [file, declaration] of declarations) {
			if (isolated.has(file)) continue;
			const source = app_program.getSourceFile(file);
			if (
				!source ||
				app_result.emitSkipped ||
				app_result.diagnostics.some((diagnostic) => diagnostic.file?.fileName === file) ||
				app_declarations.get(file) !== declaration ||
				app_program.getSyntacticDiagnostics(source).length ||
				app_program.getSemanticDiagnostics(source).length
			) {
				isolated.add(file);
			}
		}
		const candidates = [...declarations.keys()].filter((file) => !isolated.has(file));
		if (app_config && candidates.length) {
			// App strictness and lib settings must not change the comparison's inferred
			// declarations, but sharing a source must not introduce new app diagnostics.
			const checked = create_app_program({ ...app_config.options, noEmit: true }, [
				...candidates,
				...app_config.fileNames.filter((file) => /\.d\.[cm]?ts$/.test(file))
			]);
			for (const file of candidates) {
				const source = checked.getSourceFile(file);
				if (
					!source ||
					checked.getSyntacticDiagnostics(source).length ||
					checked.getSemanticDiagnostics(source).length
				) {
					isolated.add(file);
				}
			}
		}
	}
	// Shared islands retain their original nominal identity. Copy every declaration
	// that can reach a worker-specific dependency instead of reopening that graph.
	let changed = true;
	while (changed) {
		changed = false;
		for (const [file, imported] of references) {
			const dependency = [...imported].find((dependency) => isolated.has(dependency));
			if (!isolated.has(file) && dependency) {
				isolated.add(file);
				reasons.set(file, dependency);
				changed = true;
			}
		}
	}
	for (const file of declarations.keys()) {
		if (!isolated.has(file)) declarations.delete(file);
	}
	/** @type {Map<string, Array<{ file: string; text: string; references: string }>>} */
	const ambient_parts = new Map();
	/** @type {Map<string, string>} */
	const ambient_declarations = new Map();
	/** @type {Map<string, import('typescript').ResolutionMode>} */
	const ambient_formats = new Map();
	/** @type {Map<string, string>} */
	const pattern_prefixes = new Map();
	/** @type {Set<string>} */
	const pattern_files = new Set();
	const checker = program.getTypeChecker();
	let import_id = 0;
	for (const [file, source] of sources) {
		if (source.isDeclarationFile && isolated.has(file)) {
			if (!ts.isExternalModule(source)) {
				const modules = source.statements
					.filter(ts.isModuleDeclaration)
					.filter((statement) => ts.isStringLiteral(statement.name));
				if (!modules.length) {
					let reason = file;
					while (reasons.has(reason)) reason = /** @type {string} */ (reasons.get(reason));
					throw new Error(
						`Cannot isolate global worker declaration ${file} (reaches ${reason}). Export worker-only types from a file module instead.`
					);
				}
				const shared = source.statements
					.filter(
						(statement) => !ts.isModuleDeclaration(statement) || !ts.isStringLiteral(statement.name)
					)
					.map((statement) => statement.getText(source));
				/** @param {import('typescript').FileReference} reference @param {string | undefined} dependency */
				const reference_directive = (reference, dependency) => {
					const resolved = dependency && path.resolve(dependency);
					const referenced = resolved && sources.get(resolved);
					// Isolated ambient scripts are already materialized as file modules.
					// Referencing their original files would reopen the worker-only graph.
					if (resolved && referenced && isolated.has(resolved) && !ts.isExternalModule(referenced))
						return '';
					const start = source.text.lastIndexOf('///', reference.pos);
					return source.text.slice(start, source.text.indexOf('>', reference.end) + 1);
				};
				const reference_text = [
					...source.referencedFiles.map((reference) =>
						reference_directive(reference, path.resolve(path.dirname(file), reference.fileName))
					),
					...source.typeReferenceDirectives.map((reference) =>
						reference_directive(reference, resolve_type_reference(reference, file))
					)
				]
					.filter(Boolean)
					.join('\n');
				for (const module of modules) {
					if (!module.body || !ts.isModuleBlock(module.body)) {
						throw new Error(
							`Cannot isolate worker declaration ${file}. Export worker-only types from a file module instead.`
						);
					}
					const name = /** @type {import('typescript').StringLiteral} */ (module.name).text;
					const target =
						ambient_declarations.get(name) ??
						`${file}.ambient-${createHash('sha256').update(name).digest('hex').slice(0, 24)}.d.ts`;
					const pattern = augmented_patterns.has(name);
					const prefix = `sveltekit:worker:${path.basename(worker_declaration(config, target, root), '.d.ts')}:`;
					if (pattern) {
						// A shared file would spread a concrete augmentation to all matches;
						// copying each match would split private classes and unique symbols.
						// Preserve the pattern so TypeScript keeps both identities intact.
						pattern_prefixes.set(name, prefix);
						pattern_files.add(target);
					}
					const commonjs = [...(ambient_files.get(name) ?? [])].some((file) =>
						sources
							.get(file)
							?.statements.some(
								(statement) =>
									ts.isModuleDeclaration(statement) &&
									ts.isStringLiteral(statement.name) &&
									statement.name.text === name &&
									statement.body &&
									ts.isModuleBlock(statement.body) &&
									statement.body.statements.some(
										(statement) => ts.isExportAssignment(statement) && statement.isExportEquals
									)
							)
					);
					const code = new MagicString(source.text);
					/** @type {Map<import('typescript').Symbol, string>} */
					const imports = new Map();
					/** @param {import('typescript').Node} node */
					const collect_imports = (node) => {
						if (
							(ts.isImportClause(node) ||
								ts.isImportSpecifier(node) ||
								ts.isNamespaceImport(node) ||
								ts.isImportEqualsDeclaration(node)) &&
							node.name &&
							!(
								ts.canHaveModifiers(node) &&
								ts
									.getModifiers(node)
									?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
							)
						) {
							const symbol = checker.getSymbolAtLocation(node.name);
							if (symbol) {
								/** @type {string} */
								let name;
								do name = `__worker_import_${import_id++}`;
								while ([...sources.values()].some((source) => source.text.includes(name)));
								imports.set(symbol, name);
							}
						}
						ts.forEachChild(node, collect_imports);
					};
					collect_imports(module.body);
					/** @param {import('typescript').Node} node */
					const rename_imports = (node) => {
						if (ts.isExportSpecifier(node)) {
							const symbol = checker.getExportSpecifierLocalTargetSymbol(node);
							const name = symbol && imports.get(symbol);
							if (name) {
								const local = node.propertyName ?? node.name;
								code.overwrite(
									local.getStart(source),
									local.end,
									node.propertyName ? name : `${name} as ${node.name.text}`
								);
								return;
							}
						} else if (ts.isIdentifier(node)) {
							const symbol = checker.getSymbolAtLocation(node);
							const name = symbol && imports.get(symbol);
							if (name) {
								const parent = node.parent;
								code.overwrite(
									node.getStart(source),
									node.end,
									ts.isImportSpecifier(parent) && parent.name === node && !parent.propertyName
										? `${node.text} as ${name}`
										: name
								);
								return;
							}
						}
						ts.forEachChild(node, rename_imports);
					};
					// Imports are local to each ambient block, even when exported interfaces
					// merge. Keep those bindings distinct after combining the declarations.
					rename_imports(module.body);
					const statements = module.body.statements.map((statement) => {
						if (pattern) return code.slice(statement.getStart(source), statement.end);
						const modifiers = ts.canHaveModifiers(statement)
							? ts.getModifiers(statement)
							: undefined;
						const prefix =
							modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ||
							ts.isImportDeclaration(statement) ||
							ts.isImportEqualsDeclaration(statement) ||
							ts.isExportDeclaration(statement) ||
							ts.isExportAssignment(statement)
								? ''
								: !commonjs
									? 'export '
									: ts.isInterfaceDeclaration(statement) ||
										  ts.isTypeAliasDeclaration(statement) ||
										  modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
										? ''
										: 'declare ';
						return prefix + code.slice(statement.getStart(source), statement.end);
					});
					const parts = ambient_parts.get(target) ?? [];
					const first_part = !parts.some((part) => part.file === file);
					parts.push({
						file,
						references: first_part ? reference_text : '',
						text: pattern
							? [
									`declare module ${JSON.stringify(prefix + name)} {`,
									...(first_part ? shared.map((text) => text.replace(/^declare\s+/, '')) : []),
									...statements,
									'}'
								].join('\n')
							: [...(first_part ? shared : []), ...statements].join('\n')
					});
					ambient_parts.set(target, parts);
					declarations.set(target, '');
					ambient_declarations.set(name, target);
					ambient_formats.set(target, commonjs ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext);
				}
			} else {
				declarations.set(file, source.text);
			}
		}
	}

	/** @type {Map<string, string>} */
	const destinations = new Map();
	for (const file of declarations.keys()) {
		let target = worker_declaration(config, file, root);
		// Route entries keep their stable $types import path. Relocated dependencies
		// must retain their module format instead of inheriting the app package's type.
		if (!worker_files.has(file)) {
			const format = ambient_formats.get(file) ?? sources.get(file)?.impliedNodeFormat;
			if (format !== undefined) {
				target = target.replace(
					/\.d\.ts$/,
					format === ts.ModuleKind.CommonJS ? '.d.cts' : '.d.mts'
				);
			}
		}
		destinations.set(file, target);
	}
	/** @type {Map<string, Set<string>>} */
	const pattern_references = new Map();
	/** @type {Map<string, string>} */
	const aliases = new Map();
	const pattern_destinations = new Set([...pattern_files].map((file) => destinations.get(file)));

	/** @param {string} original_file @param {string} text @param {string} target */
	function rewrite_declaration(original_file, text, target) {
		const source = ts.createSourceFile(
			original_file.replace(/\.[^.]+$/, '.d.ts'),
			text,
			ts.ScriptTarget.Latest,
			true
		);
		// Re-parsing emitted text loses the original file's ESM/CommonJS context.
		source.impliedNodeFormat = program.getSourceFile(original_file)?.impliedNodeFormat;
		const code = new MagicString(text);
		visit_imports(source, (node) => {
			const resolved = ts.resolveModuleName(
				node.text,
				original_file,
				program.getCompilerOptions(),
				host,
				undefined,
				undefined,
				program.getModeForUsageLocation(source, node)
			).resolvedModule;
			const name = resolve_ambient_module(node.text, resolved);
			const ambient = name && ambient_declarations.get(name);
			const prefix = name && pattern_prefixes.get(name);
			if (ambient && prefix) {
				const destination = /** @type {string} */ (destinations.get(ambient));
				if (destination !== target) {
					const headers = pattern_references.get(target) ?? new Set();
					headers.add(
						`/// <reference path=${JSON.stringify('./' + posixify(path.relative(path.dirname(target), destination)))} />`
					);
					pattern_references.set(target, headers);
				}
				code.overwrite(node.getStart(source), node.end, JSON.stringify(prefix + node.text));
				return;
			}
			const resolved_file = name ? undefined : resolved && path.resolve(resolved.resolvedFileName);
			const resolved_source = resolved_file && sources.get(resolved_file);
			if (
				ambient ||
				(resolved_file &&
					(declarations.has(resolved_file) ||
						(resolved_source && ts.isExternalModule(resolved_source)) ||
						node.text.startsWith('.')))
			) {
				const destination = /** @type {string} */ (
					destinations.get(ambient ?? resolved_file ?? '') ?? resolved_file
				);
				if (pattern_destinations.has(target)) {
					// Ambient module bodies cannot import relative paths. A types-only
					// package alias resolves to the same file without duplicating its symbols.
					const alias = `__sveltekit_worker_${createHash('sha256').update(destination).digest('hex').slice(0, 24)}`;
					aliases.set(alias, destination);
					code.overwrite(node.getStart(source), node.end, JSON.stringify(alias));
					return;
				}
				const relative = posixify(path.relative(path.dirname(target), destination)).replace(
					/\.d\.([cm]?)ts$/,
					'.$1js'
				);
				code.overwrite(node.getStart(source), node.end, JSON.stringify(`./${relative}`));
			}
		});
		for (const reference of source.referencedFiles) {
			const original = path.resolve(path.dirname(original_file), reference.fileName);
			const destination = destinations.get(original) ?? original;
			code.overwrite(
				reference.pos,
				reference.end,
				'./' + posixify(path.relative(path.dirname(target), destination))
			);
		}
		for (const reference of source.typeReferenceDirectives) {
			const resolved = resolve_type_reference(reference, original_file);
			if (!resolved) continue;
			const original = path.resolve(resolved);
			const destination = destinations.get(original) ?? original;
			// A package lookup would reopen the original graph, including worker libs.
			// A path reference also preserves the exact conditional-export resolution.
			const start = text.lastIndexOf('///', reference.pos);
			const end = text.indexOf('>', reference.end) + 1;
			code.overwrite(
				start,
				end,
				`/// <reference path=${JSON.stringify('./' + posixify(path.relative(path.dirname(target), destination)))} />`
			);
		}
		// A source's worker-only lib reference must not change the app program's globals.
		for (const match of text.matchAll(
			/^\s*\/\/\/\s*<reference\s+(?:lib|no-default-lib)=[^\n]+/gm
		)) {
			code.remove(match.index, match.index + match[0].length);
		}
		return code.toString();
	}

	/** @type {Set<string>} */
	const outputs = new Set();
	for (const [file, text] of declarations) {
		const target = /** @type {string} */ (destinations.get(file));
		const parts = ambient_parts.get(file) ?? [{ file, text, references: '' }];
		// TypeScript only reads reference directives before the first statement.
		// Keep references from every fragment at the start of the combined module.
		const headers = new Set(
			parts
				.filter((part) => part.references)
				.map((part) => rewrite_declaration(part.file, part.references, target))
		);
		const rewritten = parts.map((part) => rewrite_declaration(part.file, part.text, target));
		const content = [...(pattern_references.get(target) ?? []), ...headers, ...rewritten].join(
			'\n'
		);
		if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== content)
			write(target, content);
		outputs.add(path.basename(target));
	}
	if (aliases.size) {
		const packages = path.join(directory, 'node_modules');
		for (const [name, destination] of aliases) {
			const target = path.join(packages, name);
			const file = path.join(target, 'package.json');
			const content = JSON.stringify({ types: posixify(path.relative(target, destination)) });
			if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) write(file, content);
		}
		for (const file of fs.readdirSync(packages)) {
			if (!aliases.has(file))
				fs.rmSync(path.join(packages, file), { recursive: true, force: true });
		}
		outputs.add('node_modules');
	}
	for (const file of fs.readdirSync(directory)) {
		if (!outputs.has(file)) fs.rmSync(path.join(directory, file), { recursive: true, force: true });
	}
	// Retain deleted dependencies so recreating one also refreshes the snapshots.
	dependencies.set(root, new Set([...(dependencies.get(root) ?? []), ...inputs]));
	missing_directories.set(root, missing);
}

/**
 * @param {import('typescript').SourceFile} source
 * @param {(literal: import('typescript').StringLiteralLike) => void} visit
 */
function visit_imports(source, visit) {
	/** @type {Set<import('typescript').Node>} */
	const seen = new Set();
	/** @param {import('typescript').Node} node */
	const walk = (node) => {
		if (seen.has(node)) return;
		seen.add(node);
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier &&
			ts.isStringLiteralLike(node.moduleSpecifier)
		) {
			visit(node.moduleSpecifier);
		} else if (
			ts.isExternalModule(source) &&
			ts.isModuleDeclaration(node) &&
			ts.isStringLiteral(node.name)
		) {
			// An augmentation identifies the same module as an import. Relocating only
			// its imports would silently attach the added types to a different module.
			visit(node.name);
		} else if (
			ts.isImportTypeNode(node) &&
			ts.isLiteralTypeNode(node.argument) &&
			ts.isStringLiteralLike(node.argument.literal)
		) {
			visit(node.argument.literal);
		} else if (ts.isExternalModuleReference(node) && ts.isStringLiteralLike(node.expression)) {
			visit(node.expression);
		} else if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
			node.arguments[0] &&
			ts.isStringLiteralLike(node.arguments[0])
		) {
			visit(node.arguments[0]);
		} else if (ts.isJSDocImportTag(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
			visit(node.moduleSpecifier);
		}
		ts.forEachChild(node, walk);
		for (const comment of ts.getJSDocCommentsAndTags(node)) walk(comment);
	};
	walk(source);
}
