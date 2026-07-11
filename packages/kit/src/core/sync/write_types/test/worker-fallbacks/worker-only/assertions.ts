import type {
	ActionData,
	PageProps
} from '../.svelte-kit/types/src/core/sync/write_types/test/worker-fallbacks/worker-only/$types';
import type { PageWorkerActions } from '../.svelte-kit/types/src/core/sync/write_types/test/worker-fallbacks/worker-only/$worker-types';

declare const form: NonNullable<ActionData>;
form.queued;
form.rejected;

declare const props: PageProps;
props.form?.queued;

declare const actions: PageWorkerActions;
void actions;
