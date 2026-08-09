import { describe, expect, it } from "bun:test";
import { ACP_BUILTIN_SLASH_COMMANDS, executeAcpBuiltinSlashCommand } from "../src/slash-commands/acp-builtins";
import {
	BUILTIN_SLASH_COMMAND_DEFS,
	executeBuiltinSlashCommand,
	executeLocalHeadlessBuiltinSlashCommand,
	lookupBuiltinSlashCommand,
} from "../src/slash-commands/builtin-registry";
import type {
	AcpBuiltinCommandRuntime,
	SlashCommandRuntime,
	TuiSlashCommandRuntime,
} from "../src/slash-commands/types";

describe("session import command transport policy", () => {
	it("is never advertised or dispatched over ACP", async () => {
		expect(ACP_BUILTIN_SLASH_COMMANDS.some(command => command.name === "import-session")).toBe(false);
		const output: string[] = [];
		const runtime = {
			output: (text: string) => output.push(text),
		} as unknown as AcpBuiltinCommandRuntime;
		const availableLocally = lookupBuiltinSlashCommand("import-session") !== undefined;
		expect(await executeAcpBuiltinSlashCommand("/import-session codex", runtime)).toEqual(
			availableLocally ? { consumed: true } : false,
		);
		expect(output).toEqual(availableLocally ? ["Slash command /import-session is unavailable over ACP."] : []);
	});

	it("advertises and dispatches only where retained-descriptor authority is available", async () => {
		const available = process.platform === "linux";
		expect(BUILTIN_SLASH_COMMAND_DEFS.some(command => command.name === "import-session")).toBe(available);
		expect(lookupBuiltinSlashCommand("import-session") !== undefined).toBe(available);

		const tuiOutput: string[] = [];
		const tuiRuntime = {
			ctx: {
				session: {},
				sessionManager: { getCwd: () => "/workspace" },
				settings: {},
				showStatus: (text: string) => tuiOutput.push(text),
				refreshSlashCommandState: () => {},
				editor: { setText: () => {} },
			},
		} as unknown as TuiSlashCommandRuntime;
		expect(await executeBuiltinSlashCommand("/import-session unsupported", tuiRuntime)).toBe(available);
		expect(tuiOutput).toEqual(available ? ["Usage: /import-session codex [session-id ...]"] : []);

		const headlessOutput: string[] = [];
		const headlessRuntime = {
			output: (text: string) => headlessOutput.push(text),
		} as unknown as SlashCommandRuntime;
		expect(await executeLocalHeadlessBuiltinSlashCommand("/import-session unsupported", headlessRuntime)).toEqual(
			available ? { consumed: true } : false,
		);
		expect(headlessOutput).toEqual(available ? ["Usage: /import-session codex [session-id ...]"] : []);
	});

	it.skipIf(process.platform !== "linux")(
		"retains a local handler and routes through the local TUI/headless adapter",
		async () => {
			const spec = lookupBuiltinSlashCommand("import-session");
			expect(spec).toMatchObject({ acp: false, localHeadless: true, allowArgs: true });
			expect(typeof spec?.handle).toBe("function");
			const output: string[] = [];
			const runtime = {
				ctx: {
					session: {},
					sessionManager: { getCwd: () => "/workspace" },
					settings: {},
					showStatus: (text: string) => output.push(text),
					refreshSlashCommandState: () => {},
					editor: { setText: () => {} },
				},
			} as unknown as TuiSlashCommandRuntime;
			expect(await executeBuiltinSlashCommand("/import-session unsupported", runtime)).toBe(true);
			expect(output).toEqual(["Usage: /import-session codex [session-id ...]"]);
		},
	);

	it.skipIf(process.platform !== "linux")(
		"dispatches through the explicit trusted local headless policy",
		async () => {
			const output: string[] = [];
			const runtime = {
				output: (text: string) => output.push(text),
			} as unknown as SlashCommandRuntime;
			expect(await executeLocalHeadlessBuiltinSlashCommand("/import-session unsupported", runtime)).toEqual({
				consumed: true,
			});
			expect(output).toEqual(["Usage: /import-session codex [session-id ...]"]);
		},
	);
});
