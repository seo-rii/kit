import type {
	ActionData,
	PageData,
	PageProps,
	SubmitFunction
} from './.svelte-kit/types/src/core/sync/write_types/test/worker-fallbacks/$types';
import type {
	PageWorkerActionEvent,
	PageWorkerActions,
	PageWorkerData,
	PageWorkerLoad,
	PageWorkerLoadEvent
} from './.svelte-kit/types/src/core/sync/write_types/test/worker-fallbacks/$worker-types';
import type * as WorkerTypes from './.svelte-kit/types/src/core/sync/write_types/test/worker-fallbacks/$worker-types';

declare const data: PageData;
data.layoutServer;
data.layoutWorker;
data.pageServer;
data.pageWorker;

declare const form: NonNullable<ActionData>;
form.serverSuccess;
form.serverFailure;
form.workerSuccess;
form.workerResult;
form.workerFailure;
form.type;
form.message;
// @ts-expect-error redirects do not become form data
form.location;
// @ts-expect-error action errors do not become form data
form.error;

declare const props: PageProps;
props.form?.workerSuccess;

// @ts-expect-error server and worker variants are mutually exclusive
const impossible: ActionData = { serverSuccess: true, workerSuccess: true };
void impossible;

export const submit: SubmitFunction = () => {
	return ({ result }) => {
		if (result.type === 'success') {
			if (result.data && 'serverSuccess' in result.data) result.data.serverSuccess;
			if (result.data && 'workerSuccess' in result.data) result.data.workerSuccess;
			if (result.data && 'workerResult' in result.data) result.data.workerResult;
			if (result.data && 'message' in result.data) result.data.message;
			// @ts-expect-error failure data is not successful action data
			result.data?.workerFailure;
		}

		if (result.type === 'failure') {
			if (result.data && 'serverFailure' in result.data) result.data.serverFailure;
			if (result.data && 'workerFailure' in result.data) result.data.workerFailure;
			// @ts-expect-error successful data is not failure action data
			result.data?.workerSuccess;
		}
	};
};

type WorkerSurface =
	| PageWorkerActionEvent
	| PageWorkerActions
	| PageWorkerData
	| PageWorkerLoad
	| PageWorkerLoadEvent;
declare const workerSurface: WorkerSurface;
void workerSurface;

// @ts-expect-error component props stay on the main generated type surface
type MissingPageProps = WorkerTypes.PageProps;
// @ts-expect-error server data stays on the main generated type surface
type MissingServerData = WorkerTypes.PageServerData;
declare const missing: MissingPageProps | MissingServerData;
void missing;
