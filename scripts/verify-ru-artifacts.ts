import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { validateRuManifest } from "./ru-manifest";

const output = resolve(process.argv[2] ?? "dist");
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const expected = process.env.RELEASE_TAG?.replace(/^v/, "") ?? pkg.version;
if (pkg.version !== expected || !/^\d+\.\d+\.\d+-ru\.\d+$/.test(expected)) throw new Error("RU version/tag mismatch");
async function hashFile(path: string, algorithm: string, encoding: "base64" | "hex"): Promise<string> {
	const hash = createHash(algorithm);
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest(encoding);
}
const setup = join(output, `omp-${expected}-setup.exe`);
const sha512 = await hashFile(setup, "sha512", "base64");
validateRuManifest(parse(await readFile(join(output, "ru.yml"), "utf8")), expected, sha512, (await stat(setup)).size);
const feed = parse(await readFile(join(output, "win-unpacked/resources/app-update.yml"), "utf8")) as Record<
	string,
	unknown
>;
if (feed.owner !== "AG-albino" || feed.repo !== "oh-my-pi-gui" || feed.provider !== "github" || feed.channel !== "ru") {
	throw new Error("RU package points to the wrong updater feed");
}
const pin = JSON.parse(await readFile(new URL("../ru-sidecar-source.json", import.meta.url), "utf8")) as {
	sidecarSha256: string;
};
if ((await hashFile(join(output, "win-unpacked/resources/omp.exe"), "sha256", "hex")) !== pin.sidecarSha256) {
	throw new Error("Packaged Core differs from the verified official binary");
}
console.log(
	`Verified RU ${expected}: updater owner/channel, manifest version, setup SHA-512/size and bundled Core SHA-256.`,
);
