import { Effect, ManagedRuntime } from "effect";

import { PersonalApplication, PersonalApplicationLayer } from "./application.ts";

export const createApplicationRuntime = () => ManagedRuntime.make(PersonalApplicationLayer);

export const applicationWorkflow = <A>(
	select: (application: PersonalApplication["Service"]) => Effect.Effect<A>,
): Effect.Effect<A, never, PersonalApplication> => PersonalApplication.use(select);
