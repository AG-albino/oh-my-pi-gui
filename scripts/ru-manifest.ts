interface UpdateManifest {
	version?: string;
	path?: string;
	sha512?: string;
	files?: Array<{ url?: string; sha512?: string; size?: number }>;
}

export function validateRuManifest(input: unknown, version: string, sha512: string, size: number): void {
	if (!input || typeof input !== "object") throw new Error("Invalid RU update manifest");
	const manifest = input as UpdateManifest;
	const filename = `omp-${version}-setup.exe`;
	if (manifest.version !== version) throw new Error("RU manifest version mismatch");
	if (manifest.path !== filename) throw new Error("RU manifest installer path mismatch");
	const entry = Array.isArray(manifest.files) ? manifest.files.find(file => file.url === filename) : undefined;
	if (!entry || entry.size !== size) throw new Error("RU manifest installer size mismatch");
	if (manifest.sha512 !== sha512 || entry.sha512 !== sha512) throw new Error("RU manifest SHA-512 mismatch");
}
