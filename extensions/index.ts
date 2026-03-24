/**
 * System Prompt Extension
 *
 * Adds a `/prompt` slash command that lets you switch the system prompt
 * by selecting a text file from the prompts directories.
 *
 * The prompt file content replaces the static part of the system prompt.
 * Dynamic sections (skills, project context, date, cwd) from pi's built
 * system prompt are automatically appended.
 *
 * The active prompt filename is displayed on the right side of the
 * working directory row in the footer.
 *
 * Prompt file locations (project-local overrides global on name collision):
 *   ~/.pi/agent/prompts/*.md|*.txt   - Global prompts
 *   .pi/prompts/*.md|*.txt           - Project-local prompts
 *
 * Usage:
 *   /prompt              - Show selector to pick a prompt file
 *   /prompt <name>       - Switch to prompt by filename (with or without extension)
 *   /prompt off          - Clear custom prompt, restore pi default
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename, extname } from "node:path";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, getAgentDir } from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

interface PromptFile {
	filename: string;
	content: string;
	source: "global" | "project";
}

export default function (pi: ExtensionAPI) {
	let activePromptName: string | undefined;
	let activePromptContent: string | undefined;

	// ── Prompt file helpers ─────────────────────────────────────────

	function getPromptDirs(cwd: string): { global: string; project: string } {
		return {
			global: join(getAgentDir(), "prompts"),
			project: join(cwd, ".pi", "prompts"),
		};
	}

	function listDir(dir: string): string[] {
		if (!existsSync(dir)) return [];
		try {
			return readdirSync(dir)
				.filter((f) => /\.(md|txt)$/i.test(f))
				.sort();
		} catch {
			return [];
		}
	}

	function listAllPrompts(cwd: string): PromptFile[] {
		const dirs = getPromptDirs(cwd);
		const globalFiles = listDir(dirs.global);
		const projectFiles = listDir(dirs.project);
		const byName = new Map<string, PromptFile>();

		for (const f of globalFiles) {
			const content = readFileSync(join(dirs.global, f), "utf-8").trim();
			byName.set(f, { filename: f, content, source: "global" });
		}
		for (const f of projectFiles) {
			const content = readFileSync(join(dirs.project, f), "utf-8").trim();
			byName.set(f, { filename: f, content, source: "project" });
		}

		return [...byName.values()].sort((a, b) => a.filename.localeCompare(b.filename));
	}

	function findPrompt(cwd: string, name: string): PromptFile | null {
		const all = listAllPrompts(cwd);
		const exact = all.find((p) => p.filename === name);
		if (exact) return exact;
		for (const ext of [".md", ".txt"]) {
			const match = all.find((p) => p.filename === name + ext);
			if (match) return match;
		}
		return all.find((p) => displayName(p.filename).toLowerCase() === name.toLowerCase()) ?? null;
	}

	function displayName(filename: string): string {
		return basename(filename, extname(filename));
	}

	// ── Dynamic tail extraction ─────────────────────────────────────

	function extractDynamicTail(builtPrompt: string): string {
		const markers = [
			"\nPi documentation (read only when the user asks about pi itself",
			"\n\n# Project Context\n",
			"\n\nThe following skills provide specialized instructions",
			"\nCurrent date: ",
		];
		let splitIndex = builtPrompt.length;
		for (const marker of markers) {
			const idx = builtPrompt.indexOf(marker);
			if (idx !== -1 && idx < splitIndex) splitIndex = idx;
		}
		if (splitIndex < builtPrompt.length) return builtPrompt.slice(splitIndex);
		const date = new Date().toISOString().slice(0, 10);
		const cwd = process.cwd().replace(/\\/g, "/");
		return `\nCurrent date: ${date}\nCurrent working directory: ${cwd}`;
	}

	// ── Footer ──────────────────────────────────────────────────────

	function formatTokens(count: number): string {
		if (count < 1000) return count.toString();
		if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
		if (count < 1000000) return `${Math.round(count / 1000)}k`;
		return `${(count / 1000000).toFixed(1)}M`;
	}

	function installFooter(ctx: ExtensionContext) {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					// ── Line 1: pwd (branch) • session     prompt:name ──
					let pwd = process.cwd();
					const home = process.env.HOME || process.env.USERPROFILE;
					if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;

					const branch = footerData.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;

					const sessionName = ctx.sessionManager.getSessionName?.();
					if (sessionName) pwd = `${pwd} • ${sessionName}`;

					let pwdLine: string;
					if (activePromptName) {
						const promptLabel = `prompt:${displayName(activePromptName)}`;
						const pwdWidth = visibleWidth(pwd);
						const labelWidth = visibleWidth(promptLabel);
						const minPad = 2;

						if (pwdWidth + minPad + labelWidth <= width) {
							const pad = " ".repeat(width - pwdWidth - labelWidth);
							pwdLine = theme.fg("dim", pwd) + theme.fg("accent", pad + promptLabel);
						} else {
							// Not enough room — truncate pwd to make space
							const availForPwd = width - minPad - labelWidth;
							if (availForPwd > 10) {
								const truncPwd = truncateToWidth(pwd, availForPwd, "...");
								const truncPwdWidth = visibleWidth(truncPwd);
								const pad = " ".repeat(Math.max(minPad, width - truncPwdWidth - labelWidth));
								pwdLine = theme.fg("dim", truncPwd) + theme.fg("accent", pad + promptLabel);
							} else {
								pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
							}
						}
					} else {
						pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
					}

					// ── Line 2: stats          model • thinking ──
					let totalInput = 0, totalOutput = 0, totalCost = 0;
					let totalCacheRead = 0, totalCacheWrite = 0;
					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type === "message" && (entry as any).message.role === "assistant") {
							const m = (entry as any).message as AssistantMessage;
							totalInput += m.usage.input;
							totalOutput += m.usage.output;
							totalCacheRead += m.usage.cacheRead;
							totalCacheWrite += m.usage.cacheWrite;
							totalCost += m.usage.cost.total;
						}
					}

					const contextUsage = ctx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const contextPercentValue = contextUsage?.percent ?? 0;
					const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

					const statsParts: string[] = [];
					if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
					if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
					if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
					if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);
					if (totalCost) statsParts.push(`$${totalCost.toFixed(3)}`);

					const contextDisplay = contextPercent === "?"
						? `?/${formatTokens(contextWindow)}`
						: `${contextPercent}%/${formatTokens(contextWindow)}`;
					let contextStr: string;
					if (contextPercentValue > 90) {
						contextStr = theme.fg("error", contextDisplay);
					} else if (contextPercentValue > 70) {
						contextStr = theme.fg("warning", contextDisplay);
					} else {
						contextStr = contextDisplay;
					}
					statsParts.push(contextStr);
					let statsLeft = statsParts.join(" ");
					let statsLeftWidth = visibleWidth(statsLeft);
					if (statsLeftWidth > width) {
						statsLeft = truncateToWidth(statsLeft, width, "...");
						statsLeftWidth = visibleWidth(statsLeft);
					}

					const modelName = ctx.model?.id || "no-model";
					let rightSide = modelName;
					if (ctx.model?.reasoning) {
						const level = pi.getThinkingLevel() || "off";
						rightSide = level === "off" ? `${modelName} • thinking off` : `${modelName} • ${level}`;
					}

					const rightWidth = visibleWidth(rightSide);
					let statsLine: string;
					if (statsLeftWidth + 2 + rightWidth <= width) {
						const pad = " ".repeat(width - statsLeftWidth - rightWidth);
						statsLine = statsLeft + pad + rightSide;
					} else {
						const avail = width - statsLeftWidth - 2;
						if (avail > 0) {
							const truncRight = truncateToWidth(rightSide, avail, "");
							const truncRightWidth = visibleWidth(truncRight);
							const pad = " ".repeat(Math.max(0, width - statsLeftWidth - truncRightWidth));
							statsLine = statsLeft + pad + truncRight;
						} else {
							statsLine = statsLeft;
						}
					}

					const dimStatsLeft = theme.fg("dim", statsLeft);
					const remainder = statsLine.slice(statsLeft.length);
					const dimRemainder = theme.fg("dim", remainder);

					const lines = [pwdLine, dimStatsLeft + dimRemainder];

					// ── Line 3: other extension statuses (if any) ──
					const extensionStatuses = footerData.getExtensionStatuses();
					if (extensionStatuses.size > 0) {
						const sorted = Array.from(extensionStatuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim());
						const statusLine = sorted.join(" ");
						lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
					}

					return lines;
				},
			};
		});
	}

	// ── Prompt application ──────────────────────────────────────────

	function applyPrompt(prompt: PromptFile, ctx: ExtensionContext) {
		activePromptName = prompt.filename;
		activePromptContent = prompt.content;
	}

	function clearPrompt(ctx: ExtensionContext) {
		activePromptName = undefined;
		activePromptContent = undefined;
	}

	// ── Command ─────────────────────────────────────────────────────

	pi.registerCommand("prompt", {
		description: "Switch system prompt from prompts directory",
		getArgumentCompletions: (prefix: string) => {
			const cwd = process.cwd();
			const prompts = listAllPrompts(cwd);
			const items = [
				{ value: "off", label: "off", description: "Clear custom prompt" },
				...prompts.map((p) => ({
					value: displayName(p.filename),
					label: displayName(p.filename),
					description: `${p.filename} (${p.source})`,
				})),
			];
			const filtered = items.filter((i) =>
				i.value.toLowerCase().startsWith(prefix.toLowerCase())
			);
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args?.trim();

			if (trimmed === "off") {
				clearPrompt(ctx);
				ctx.ui.notify("Custom system prompt cleared", "info");
				return;
			}

			if (trimmed) {
				const prompt = findPrompt(ctx.cwd, trimmed);
				if (!prompt) {
					const available =
						listAllPrompts(ctx.cwd).map((p) => displayName(p.filename)).join(", ") || "(none)";
					ctx.ui.notify(`Prompt "${trimmed}" not found. Available: ${available}`, "error");
					return;
				}
				applyPrompt(prompt, ctx);
				ctx.ui.notify(`System prompt set to "${displayName(prompt.filename)}"`, "info");
				return;
			}

			await showPromptSelector(ctx);
		},
	});

	// ── Selector UI ─────────────────────────────────────────────────

	async function showPromptSelector(ctx: ExtensionContext): Promise<void> {
		const prompts = listAllPrompts(ctx.cwd);

		if (prompts.length === 0) {
			ctx.ui.notify(
				"No prompt files found. Add .md or .txt files to ~/.pi/agent/prompts/ or .pi/prompts/",
				"warning"
			);
			return;
		}

		const items: SelectItem[] = prompts.map((p) => {
			const name = displayName(p.filename);
			const isActive = p.filename === activePromptName;
			const preview = p.content.split("\n")[0]?.slice(0, 60) ?? "";
			return {
				value: p.filename,
				label: isActive ? `${name} (active)` : name,
				description: `[${p.source}] ${preview}${p.content.length > 60 ? "…" : ""}`,
			};
		});

		items.push({
			value: "(off)",
			label: "(off)",
			description: "Clear custom prompt, restore pi default",
		});

		const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold("Select System Prompt")), 1, 0));

			const selectList = new SelectList(items, Math.min(items.length, 12), {
				selectedPrefix: (t: string) => theme.fg("accent", t),
				selectedText: (t: string) => theme.fg("accent", t),
				description: (t: string) => theme.fg("muted", t),
				scrollInfo: (t: string) => theme.fg("dim", t),
				noMatch: (t: string) => theme.fg("warning", t),
			});
			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);
			container.addChild(selectList);
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => { selectList.handleInput(data); tui.requestRender(); },
			};
		});

		if (!result) return;

		if (result === "(off)") {
			clearPrompt(ctx);
			ctx.ui.notify("Custom system prompt cleared", "info");
			return;
		}

		const prompt = prompts.find((p) => p.filename === result);
		if (prompt) {
			applyPrompt(prompt, ctx);
			ctx.ui.notify(`System prompt set to "${displayName(prompt.filename)}"`, "info");
		}
	}

	// ── Events ──────────────────────────────────────────────────────

	pi.on("before_agent_start", async (event) => {
		if (activePromptContent) {
			const dynamicTail = extractDynamicTail(event.systemPrompt);
			return { systemPrompt: activePromptContent + dynamicTail };
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === "system-prompt-state") {
				const data = (entry as { data?: { filename: string } }).data;
				if (data?.filename) {
					const prompt = findPrompt(ctx.cwd, data.filename);
					if (prompt) {
						activePromptName = prompt.filename;
						activePromptContent = prompt.content;
					}
				}
			}
		}
		installFooter(ctx);
	});

	pi.on("turn_start", async () => {
		if (activePromptName) {
			pi.appendEntry("system-prompt-state", { filename: activePromptName });
		}
	});
}
