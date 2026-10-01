import assert from "node:assert/strict";
import { test } from "node:test";
import { candidateProcedureIds, renderGuidance, sameProcedure, validateProcedurePool } from "../procedures.ts";
import { renderGuidance as compatibilityRenderGuidance } from "../state.ts";
import { failure, proposal, success } from "./fixtures.ts";

test("shared rendering preserves the exact production prompt and the existing state-module export", () => {
	const expected =
		"Repository-scoped procedural guidance. Recheck applicability against the current task; it does not override user instructions or permissions.\n\n" +
		"Edit generator inputs\nWhen: The requested change affects generated files.\n" +
		"Do: Edit the generator input, then regenerate the output.\n" +
		"Verify: Run the generator twice and confirm the second run has no diff.\n" +
		"Do not apply when: The file is maintained by hand.";
	assert.equal(renderGuidance([proposal()]), expected);
	assert.equal(compatibilityRenderGuidance([proposal()]), expected);
	assert.equal(compatibilityRenderGuidance, renderGuidance);
	assert.equal(renderGuidance([]), "");
});

test("the shared pool rule enforces replacement, stable ordering, uniqueness, and semantic deduplication", () => {
	const current = proposal("current");
	const other = proposal("other", "testing/contracts");
	const replacement = { ...proposal("new"), replaces: "current" };
	assert.deepEqual(success(candidateProcedureIds([current, other], replacement)), ["other", "new"]);
	failure(candidateProcedureIds([current], { ...replacement, replaces: null }), /explicitly replace/);
	failure(validateProcedurePool([current, { ...other, id: "current" }]), /IDs must be unique/);
	failure(validateProcedurePool([current, { ...current, id: "another" }]), /one procedure per behavior/);
	const renamed = {
		...current,
		procedure: {
			...current.procedure,
			title: "Cosmetic rename",
			action: current.procedure.action.toUpperCase().replaceAll(" ", "\n"),
		},
	};
	assert.equal(sameProcedure(current, renamed), true);
	assert.equal(
		sameProcedure(current, { ...renamed, procedure: { ...renamed.procedure, avoid: "A different exception." } }),
		false,
	);
});
