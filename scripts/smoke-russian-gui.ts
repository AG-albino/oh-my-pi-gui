/** Exercise an actual packaged app in a disposable profile without credentials. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

const executable = process.argv[2];
if (!executable) throw new Error("Usage: node scripts/smoke-russian-gui.ts <packaged-executable>");
const temporary = await mkdtemp(join(tmpdir(), "omp-ru-gui-"));
const profile = join(temporary, "profile");
const agent = join(temporary, "agent");
const home = join(temporary, "home");
const project = join(temporary, "project");
await Promise.all([profile, agent, home, project].map(path => mkdir(path, { recursive: true })));
await writeFile(join(profile, "prefs.json"), JSON.stringify({ language: "ru", firstRunComplete: true, theme: "dark" }));
const environment = {
	...process.env,
	HOME: home,
	USERPROFILE: home,
	PI_CODING_AGENT_DIR: agent,
	PI_NOTIFICATIONS: "off",
};
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.OMP_BUNDLED_OMP;
const launch = () =>
	electron.launch({
		executablePath: resolve(executable),
		args: [project, `--user-data-dir=${profile}`],
		env: environment,
		timeout: 45_000,
	});
let application: Awaited<ReturnType<typeof launch>> | undefined;
try {
	application = await launch();
	let page = await application.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	await application.evaluate(({ BrowserWindow }) =>
		BrowserWindow.getAllWindows().forEach(window => {
			window.hide();
		}),
	);
	await page.waitForFunction(() => document.documentElement.lang === "ru");
	await page.getByRole("button", { name: "Сменить язык" }).first().click();
	await page.getByRole("menuitem", { name: "English" }).click();
	await page.waitForFunction(() => document.documentElement.lang === "en");
	await page.getByRole("button", { name: "Switch language" }).first().click();
	await page.getByRole("menuitem", { name: "Русский" }).click();
	await page.waitForFunction(() => document.documentElement.lang === "ru");
	if ((await page.evaluate(() => window.omp.prefs.get("language"))) !== "ru") throw new Error("Preference not saved");
	const fileMenu = await application.evaluate(({ Menu }) =>
		Menu.getApplicationMenu()?.items.some(item => item.label === "Файл"),
	);
	if (!fileMenu) throw new Error("Russian native menu missing");
	if (errors.length) throw new Error(`Renderer errors: ${errors.join("\n")}`);
	if (process.env.OMP_RU_SCREENSHOT) await page.screenshot({ path: resolve(process.env.OMP_RU_SCREENSHOT) });
	await application.close();
	application = undefined;
	application = await launch();
	page = await application.firstWindow();
	await application.evaluate(({ BrowserWindow }) =>
		BrowserWindow.getAllWindows().forEach(window => {
			window.hide();
		}),
	);
	await page.waitForFunction(() => document.documentElement.lang === "ru");
	const prefs = JSON.parse(await readFile(join(profile, "prefs.json"), "utf8")) as { language?: string };
	if (prefs.language !== "ru") throw new Error("Russian was lost after restart");
	console.log("PASS: packaged RU → EN → RU, native menu, persisted preference and restart");
} finally {
	if (application) await application.close();
	await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
