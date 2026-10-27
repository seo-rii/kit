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

	const config_file = [
		path.join(config.kit.outDir, 'tsconfig.worker.json'),
		path.join(root, 'tsconfig.worker.json'),
		path.join(root, 'tsconfig.json')
	].find((file) => fs.existsSync(file));
	const parsed = config_file
		? ts.getParsedCommandLineOfConfigFile(
				config_file,
				{},
				{
					...ts.sys,
					onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
						throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
					}
				}
			)
		: undefined;
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
	/** @type {Set<string>} */
	const inputs = new Set(workers);
	/** @type {Set<string>} */
	const missing = new Set();
	const host = ts.createCompilerHost(options, true);
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
	const roots = new Set([
		...workers,
		...generated,
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
	/** @type {Map<string, string>} */
	const ambient_files = new Map();
	for (const source of program.getSourceFiles()) {
		if (source.isDeclarationFile && !ts.isExternalModule(source)) {
			for (const statement of source.statements) {
				if (ts.isModuleDeclaration(statement) && ts.isStringLiteral(statement.name)) {
					ambient_files.set(statement.name.text, path.resolve(source.fileName));
				}
			}
		}
	}
	for (const source of program.getSourceFiles()) {
		if (program.isSourceFileDefaultLibrary(source)) continue;
		const file = path.resolve(source.fileName);
		if (file.startsWith(directory + path.sep)) continue;
		inputs.add(file);
		sources.set(file, source);
		if (
			!source.isDeclarationFile ||
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
		visit_imports(source, (literal) => {
			const resolved = ts.resolveModuleName(literal.text, file, options, ts.sys).resolvedModule;
			const dependency = ambient_files.get(literal.text) ?? resolved?.resolvedFileName;
			if (dependency) imported.add(path.resolve(dependency));
		});
		references.set(file, imported);
	}
	// Shared declaration-only islands retain their original identity (private fields
	// and unique-symbol brands included). Copy every declaration that can reach an
	// implementation or a worker lib reference instead of reopening that graph in the app.
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
	/** @type {Map<string, string>} */
	const origins = new Map();
	/** @type {Map<string, string>} */
	const ambient_declarations = new Map();
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
				for (const module of modules) {
					if (!module.body || !ts.isModuleBlock(module.body)) {
						throw new Error(
							`Cannot isolate worker declaration ${file}. Export worker-only types from a file module instead.`
						);
					}
					const name = /** @type {import('typescript').StringLiteral} */ (module.name).text;
					const target = `${file}.ambient-${createHash('sha256').update(name).digest('hex').slice(0, 24)}.d.ts`;
					const statements = module.body.statements.map((statement) => {
						const exported =
							ts.canHaveModifiers(statement) &&
							ts
								.getModifiers(statement)
								?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
						const prefix =
							exported ||
							ts.isImportDeclaration(statement) ||
							ts.isImportEqualsDeclaration(statement) ||
							ts.isExportDeclaration(statement) ||
							ts.isExportAssignment(statement)
								? ''
								: 'export ';
						return prefix + statement.getText(source);
					});
					const previous = declarations.get(target);
					declarations.set(
						target,
						previous
							? previous + '\n' + statements.join('\n')
							: [...shared, ...statements].join('\n')
					);
					origins.set(target, file);
					ambient_declarations.set(name, target);
				}
			} else {
				declarations.set(file, source.text);
			}
		}
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

	/** @type {Set<string>} */
	const outputs = new Set();
	for (const [file, text] of declarations) {
		const target = worker_declaration(config, file, root);
		const original_file = origins.get(file) ?? file;
		const source = ts.createSourceFile(
			file.replace(/\.[^.]+$/, '.d.ts'),
			text,
			ts.ScriptTarget.Latest,
			true
		);
		const code = new MagicString(text);
		visit_imports(source, (node) => {
			const resolved = ts.resolveModuleName(
				node.text,
				original_file,
				program.getCompilerOptions(),
				ts.sys
			).resolvedModule;
			const ambient = ambient_declarations.get(node.text);
			const resolved_file =
				ambient_files.get(node.text) ?? (resolved && path.resolve(resolved.resolvedFileName));
			const resolved_source = resolved_file && sources.get(resolved_file);
			if (
				ambient ||
				(resolved_file &&
					(declarations.has(resolved_file) ||
						(resolved_source && ts.isExternalModule(resolved_source)) ||
						node.text.startsWith('.')))
			) {
				const destination = ambient
					? worker_declaration(config, ambient, root)
					: declarations.has(/** @type {string} */ (resolved_file))
						? worker_declaration(config, /** @type {string} */ (resolved_file), root)
						: /** @type {string} */ (resolved_file);
				const relative = posixify(path.relative(path.dirname(target), destination)).replace(
					/\.d\.ts$/,
					'.js'
				);
				code.overwrite(node.getStart(source), node.end, JSON.stringify(`./${relative}`));
			}
		});
		for (const reference of source.referencedFiles) {
			const original = path.resolve(path.dirname(original_file), reference.fileName);
			const destination = declarations.has(original)
				? worker_declaration(config, original, root)
				: original;
			code.overwrite(
				reference.pos,
				reference.end,
				'./' + posixify(path.relative(path.dirname(target), destination))
			);
		}
		// A source's worker-only lib reference must not change the app program's globals.
		for (const match of text.matchAll(
			/^\s*\/\/\/\s*<reference\s+(?:lib|no-default-lib)=[^\n]+/gm
		)) {
			code.remove(match.index, match.index + match[0].length);
		}
		const content = code.toString();
		if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== content)
			write(target, content);
		outputs.add(path.basename(target));
	}
	for (const file of fs.readdirSync(directory)) {
		if (!outputs.has(file)) fs.rmSync(path.join(directory, file), { force: true });
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
	/** @param {import('typescript').Node} node */
	const walk = (node) => {
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier &&
			ts.isStringLiteralLike(node.moduleSpecifier)
		) {
			visit(node.moduleSpecifier);
		} else if (
			ts.isImportTypeNode(node) &&
			ts.isLiteralTypeNode(node.argument) &&
			ts.isStringLiteralLike(node.argument.literal)
		) {
			visit(node.argument.literal);
		} else if (ts.isExternalModuleReference(node) && ts.isStringLiteralLike(node.expression)) {
			visit(node.expression);
		}
		ts.forEachChild(node, walk);
	};
	walk(source);
}
