import { describe, expect, it } from "vitest";
import { validateRuManifest } from "../../scripts/ru-manifest";

const valid = {
	version: "0.9.22-ru.1",
	path: "omp-0.9.22-ru.1-setup.exe",
	sha512: "actual-hash",
	files: [{ url: "omp-0.9.22-ru.1-setup.exe", sha512: "actual-hash", size: 1234 }],
};

describe("RU update artifact verification", () => {
	it("accepts matching installer metadata", () => {
		expect(() => validateRuManifest(valid, "0.9.22-ru.1", "actual-hash", 1234)).not.toThrow();
	});
	it("rejects a stale version, redirected installer, hash mismatch and truncated installer", () => {
		expect(() =>
			validateRuManifest({ ...valid, version: "0.9.21-ru.1" }, "0.9.22-ru.1", "actual-hash", 1234),
		).toThrow("version");
		expect(() =>
			validateRuManifest({ ...valid, path: "../another.exe" }, "0.9.22-ru.1", "actual-hash", 1234),
		).toThrow("path");
		expect(() => validateRuManifest(valid, "0.9.22-ru.1", "tampered-hash", 1234)).toThrow("SHA-512");
		expect(() => validateRuManifest(valid, "0.9.22-ru.1", "actual-hash", 1233)).toThrow("size");
	});
});
