import { existsSync } from "fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

/**
 * pi-container-links
 *
 * Auto-extracts file paths from Pi assistant responses and displays them as
 * clickable OSC 8 hyperlinks in a "Sources" widget above the editor.
 *
 * Solves the container path problem: Pi inside a container sees files at
 * /workspace/... but the host filesystem has them elsewhere. This extension
 * maps container paths to host paths so Cmd+Click / Ctrl+Click opens files
 * in your host editor.
 *
 * Works with Docker, dev containers, remote SSH, or any setup where Pi's
 * working directory doesn't match the host filesystem.
 *
 * Supported terminals: Ghostty, iTerm2, Kitty, WezTerm, Windows Terminal,
 * GNOME Terminal (VTE 0.50+), foot, Konsole, Alacritty.
 *
 * Configuration:
 *   PI_PATH_MAP=/workspace:/Users/you   # containerPrefix:hostPrefix
 *   PI_SOURCES_MAX_LINKS=5              # max links shown in widget
 *   PI_SOURCES_WIDGET=1                 # 0 to disable widget
 */

interface LinkEntry {
  path: string;        // Display path (container path)
  url: string;         // file:// URL (host path)
  timestamp: number;
}

// --- Configuration ---

function getPathMapping(): { container: string; host: string } | null {
  const env = process.env.PI_PATH_MAP;
  if (env) {
    const idx = env.indexOf(":");
    if (idx > 0) {
      return {
        container: env.slice(0, idx),
        host: env.slice(idx + 1),
      };
    }
  }

  // Auto-detect: if HOME is /Users/xyz and we're in /workspace, assume macOS Docker
  const home = process.env.HOME || "";
  const cwd = process.cwd();
  if (home && cwd.startsWith("/workspace")) {
    return { container: "/workspace", host: home };
  }

  return null;
}

function getMaxLinks(): number {
  const env = process.env.PI_SOURCES_MAX_LINKS;
  return env ? parseInt(env, 10) || 5 : 5;
}

function isWidgetEnabled(): boolean {
  return process.env.PI_SOURCES_WIDGET !== "0";
}

// --- Path Detection ---

const FILE_EXTS = new Set([
  "ts","tsx","js","jsx","mjs","cjs","html","htm","css","scss","sass","less",
  "json","yaml","yml","toml","xml","md","mdx","txt","rst","py","rb","go","rs",
  "java","kt","scala","c","cpp","cc","h","hpp","php","swift","dart","lua","r",
  "sh","bash","zsh","fish","sql","graphql","prisma","proto","nix","dockerfile",
  "png","jpg","jpeg","gif","svg","webp","ico","pdf","doc","docx","xls","xlsx",
  "zip","tar","gz","bz2","7z","log","env","conf","config","ini","lock",
]);

function hasFileExt(path: string): boolean {
  const base = path.split("/").pop() || "";
  const ext = base.split(".").pop()?.toLowerCase();
  return ext ? FILE_EXTS.has(ext) : false;
}

function resolvePath(path: string, cwd: string): string {
  if (path.startsWith("/")) return path;
  const clean = path.replace(/^\.\//, "");
  return cwd.endsWith("/") ? cwd + clean : cwd + "/" + clean;
}

function looksLikePath(path: string, cwd: string): boolean {
  const abs = resolvePath(path, cwd);

  // Quick reject: must be under /workspace (or mapped container prefix)
  const mapping = getPathMapping();
  const containerPrefix = mapping?.container || "/workspace";
  if (!abs.startsWith(containerPrefix + "/")) return false;

  // Ultimate litmus test: does it exist on the filesystem?
  if (existsSync(abs)) return true;

  // Also accept if the parent directory exists (file may not exist yet,
  // but path structure is valid — e.g. assistant mentions a new file)
  const lastSlash = abs.lastIndexOf("/");
  if (lastSlash > 0) {
    const parent = abs.slice(0, lastSlash);
    if (existsSync(parent)) return true;
  }

  // Fallback: known file extension in a valid-looking path
  if (hasFileExt(path) && path.includes("/")) return true;

  return false;
}

// --- Path Mapping ---

function toHostPath(path: string, cwd: string): string | null {
  const mapping = getPathMapping();

  // Already a host path
  if (path.startsWith("/Users/") || path.startsWith("/home/")) {
    return path;
  }

  // Map container prefix to host prefix
  if (mapping && path.startsWith(mapping.container)) {
    return path.replace(mapping.container, mapping.host);
  }

  // Resolve relative paths against cwd, then map
  if (!path.startsWith("/")) {
    const clean = path.replace(/^\.\//, "");
    const abs = cwd.endsWith("/") ? cwd + clean : cwd + "/" + clean;
    return toHostPath(abs, cwd);
  }

  // Path doesn't map to host — reject it
  return null;
}

// --- OSC 8 Hyperlinks ---

function makeOsc8(text: string, url: string): string {
  // Use BEL (\x07) terminator for maximum compatibility.
  // ST (\x1b\\) is spec-correct but fails in some rendering contexts
  // (e.g., tmux without passthrough, some TUI widget paths).
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

// --- Link Extraction ---

// Matches:
//   /absolute/paths
//   ./relative/paths
//   ../parent/paths
//   bare/paths/with/slashes
//   path:line
//   path:line:col
const PATH_REGEX = /(?<![\w/])(\/[^\s\n`'"<>|]+|\.{1,2}\/[^\s\n`'"<>|]+|[\w-]+\/[^\s\n`'"<>|]*)/g;

// Line/column suffix: :123 or :123:45
const LINE_COL_REGEX = /:(\d+)(?::(\d+))?$/;

function extractLinks(text: string, cwd: string): LinkEntry[] {
  const links: LinkEntry[] = [];
  const seen = new Set<string>();

  let match: RegExpExecArray | null;
  while ((match = PATH_REGEX.exec(text)) !== null) {
    let raw = match[0];

    // Strip trailing punctuation
    raw = raw.replace(/[.,;:!?]+$/, "");

    if (!looksLikePath(raw, cwd)) continue;
    if (raw.startsWith("http://") || raw.startsWith("https://")) continue;

    // Skip URL authority paths like //test-results matched from file://... or http://...
    if (raw.startsWith("//")) {
      const matchStart = match.index ?? 0;
      const charBefore = matchStart > 0 ? text[matchStart - 1] : "";
      if (charBefore === ":") continue;
    }

    // Extract line:col suffix if present
    let path = raw;
    let line: string | undefined;
    let col: string | undefined;

    const lcMatch = raw.match(LINE_COL_REGEX);
    if (lcMatch) {
      path = raw.slice(0, -lcMatch[0].length);
      line = lcMatch[1];
      col = lcMatch[2];
    }

    const hostPath = toHostPath(path, cwd);
    if (!hostPath) continue; // reject paths that don't map to host

    const encoded = encodeURIComponent(hostPath).replace(/%2F/g, "/");

    // Build file:// URL with line/column fragment
    let url = `file://${encoded}`;
    if (line) {
      url += `#L${line}`;
      if (col) url += `C${col}`;
    }

    if (seen.has(url)) continue;
    seen.add(url);

    links.push({ path: raw, url, timestamp: Date.now() });
  }

  return links;
}

// --- Widget ---

function formatLinkLabel(path: string): string {
  // Strip container prefix for cleaner display
  const mapping = getPathMapping();
  if (mapping && path.startsWith(mapping.container + "/")) {
    return path.slice(mapping.container.length + 1);
  }
  if (path.startsWith("/workspace/")) {
    return path.slice("/workspace/".length);
  }
  return path;
}

function updateLinkWidget(ctx: ExtensionContext) {
  if (!isWidgetEnabled() || !widgetVisible || linkHistory.length === 0) {
    ctx.ui.setWidget("pi-container-links", undefined);
    return;
  }

  const recent = linkHistory.slice(-widgetMaxLinks);
  const total = linkHistory.length;
  const hidden = total - recent.length;

  // Compact single-line format: emoji + "Sources:" + links
  const linkTexts = recent.map((link) => makeOsc8(formatLinkLabel(link.path), link.url));
  const more = hidden > 0 ? ` … (+${hidden} more)` : "";

  const lines: string[] = [
    `🔗 Sources: ${linkTexts.join(" · ")}${more}`,
  ];

  ctx.ui.setWidget("pi-container-links", lines, { placement: "aboveEditor" });
}

// --- State ---

let linkHistory: LinkEntry[] = [];
let widgetVisible = true;
let widgetMaxLinks = getMaxLinks();

function persistLinks(pi: ExtensionAPI) {
  pi.appendEntry("pi-container-links", { links: linkHistory });
}

function restoreLinks(ctx: ExtensionContext) {
  const entries = ctx.sessionManager.getEntries();
  for (const entry of entries) {
    if (
      entry.type === "custom" &&
      entry.customType === "pi-container-links" &&
      entry.data?.links
    ) {
      linkHistory = entry.data.links;
      return;
    }
  }
}

// --- Extension ---

export default function (pi: ExtensionAPI) {
  // Restore persisted links on session start
  pi.on("session_start", async (_event, ctx) => {
    restoreLinks(ctx);
    if (linkHistory.length > 0) {
      updateLinkWidget(ctx);
    }
  });

  // Extract links from assistant messages
  pi.on("message_end", async (event, ctx) => {
    const msg = event.message;
    if (msg.role !== "assistant" || !msg.content) return;

    const cwd = ctx.cwd || "/workspace";
    const newLinks: LinkEntry[] = [];

    for (const block of msg.content) {
      if (block.type === "text" && block.text) {
        const links = extractLinks(block.text, cwd);
        newLinks.push(...links);
      }
    }

    if (newLinks.length > 0) {
      linkHistory.push(...newLinks);
      persistLinks(pi);
      updateLinkWidget(ctx);
    }
  });

  // /sources — show links from current context (last N messages)
  pi.registerCommand("sources", {
    description: "Show source links from the current conversation context",
    handler: async (_args, ctx) => {
      if (linkHistory.length === 0) {
        ctx.ui.notify("No source links found", "info");
        return;
      }

      // Show last ~10 links as "context"
      const contextWindow = Math.min(linkHistory.length, 10);
      const recent = linkHistory.slice(-contextWindow);

      const lines = [
        `🔗 Recent sources (${recent.length} of ${linkHistory.length} total):`,
        "",
        ...recent.map((link, i) => `${i + 1}. ${makeOsc8(link.path, link.url)}`),
      ];

      if (linkHistory.length > contextWindow) {
        lines.push("", `… and ${linkHistory.length - contextWindow} more — use /sources-all to see everything`);
      }

      ctx.ui.notify(`${linkHistory.length} source links total`, "info");

      pi.sendMessage({
        customType: "pi-container-links-list",
        content: lines.join("\n"),
        display: true,
      });
    },
  });

  // /sources-all — show every link ever collected
  pi.registerCommand("sources-all", {
    description: "Show all source links from this session",
    handler: async (_args, ctx) => {
      if (linkHistory.length === 0) {
        ctx.ui.notify("No source links found", "info");
        return;
      }

      const lines = [
        `🔗 All ${linkHistory.length} source links:`,
        "",
        ...linkHistory.map((link, i) => `${i + 1}. ${makeOsc8(link.path, link.url)}`),
      ];

      ctx.ui.notify(`${linkHistory.length} source links`, "info");

      pi.sendMessage({
        customType: "pi-container-links-list",
        content: lines.join("\n"),
        display: true,
      });
    },
  });

  // /hide-sources — hide the widget
  pi.registerCommand("hide-sources", {
    description: "Hide the Sources widget (links still tracked)",
    handler: async (_args, ctx) => {
      widgetVisible = false;
      ctx.ui.setWidget("pi-container-links", undefined);
      ctx.ui.notify("Sources widget hidden — /show-sources to bring it back", "info");
    },
  });

  // /show-sources — show the widget
  pi.registerCommand("show-sources", {
    description: "Show the Sources widget",
    handler: async (_args, ctx) => {
      widgetVisible = true;
      updateLinkWidget(ctx);
      ctx.ui.notify("Sources widget visible", "info");
    },
  });

  // /sources-limit — change max links shown in widget
  pi.registerCommand("sources-limit", {
    description: "Set max links shown in the Sources widget (e.g. /sources-limit 10)",
    handler: async (args, ctx) => {
      const n = parseInt(args[0] || "", 10);
      if (isNaN(n) || n < 1 || n > 50) {
        ctx.ui.notify("Usage: /sources-limit N (1–50)", "error");
        return;
      }
      widgetMaxLinks = n;
      updateLinkWidget(ctx);
      ctx.ui.notify(`Sources widget now shows up to ${n} links`, "info");
    },
  });

  // /clear-sources — clear history
  pi.registerCommand("clear-sources", {
    description: "Clear source link history",
    handler: async (_args, ctx) => {
      linkHistory = [];
      ctx.ui.setWidget("pi-container-links", undefined);
      ctx.ui.notify("Source links cleared", "info");
    },
  });

  // Tool: register_source_link — LLM can explicitly add links
  pi.registerTool({
    name: "register_source_link",
    label: "Register Source Link",
    description:
      "Register a clickable source file link. Use when you mention a file path " +
      "that should appear in the Sources widget for quick access.",
    parameters: Type.Object({
      path: Type.String({ description: "File path (absolute or relative)" }),
      label: Type.Optional(Type.String({ description: "Optional display label" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd || "/workspace";
      const hostPath = toHostPath(params.path, cwd);
      if (!hostPath) {
        return {
          content: [{ type: "text", text: `Rejected: ${params.path} does not map to a host path` }],
          details: {},
        };
      }
      const encoded = encodeURIComponent(hostPath).replace(/%2F/g, "/");
      const url = `file://${encoded}`;
      const display = params.label || params.path;

      linkHistory.push({ path: display, url, timestamp: Date.now() });
      persistLinks(pi);
      updateLinkWidget(ctx);

      return {
        content: [{ type: "text", text: `Registered source link: ${display}` }],
        details: {},
      };
    },
  });
}
