// Draws docs/images/data-flow.svg: where Scope Soup's data lives and how it moves. Run: node docs/images/data-flow.mjs docs/images/data-flow.svg
import { writeFileSync } from "node:fs";

const out = process.argv[2];
const W = 1040, H = 664;
const C = {
  person: { fill: "#ede9fe", stroke: "#7c3aed", text: "#2e1065" },
  app: { fill: "#fef3c7", stroke: "#d97706", text: "#451a03" },
  agent: { fill: "#ffedd5", stroke: "#ea580c", text: "#431407" },
  git: { fill: "#ccfbf1", stroke: "#0d9488", text: "#042f2e" },
  remote: { fill: "#dbeafe", stroke: "#2563eb", text: "#172554" },
};
const parts = [];
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function text(x, y, lines, color, { size = 14, weight = 600, sub = [] } = {}) {
  const all = [...lines.map((l) => ({ l, size, weight, color })), ...sub.map((l) => ({ l, size: 12, weight: 400, color: color + "cc" }))];
  const lh = 17;
  const top = y - ((all.length - 1) * lh) / 2;
  all.forEach((t, i) => parts.push(`<text x="${x}" y="${top + i * lh}" font-size="${t.size}" font-weight="${t.weight}" fill="${t.color}" text-anchor="middle" dominant-baseline="middle">${esc(t.l)}</text>`));
}
function box(cx, cy, w, h, c, lines, sub) {
  parts.push(`<rect x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}" rx="10" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.6"/>`);
  text(cx, cy, lines, c.text, { sub });
}
function cyl(cx, cy, w, h, c, lines, sub) {
  const x = cx - w / 2, y = cy - h / 2, e = 8, rx = w / 2;
  parts.push(`<path d="M${x},${y + e} v${h - 2 * e} a${rx},${e} 0 0,0 ${w},0 v${-(h - 2 * e)}" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.6"/>`);
  parts.push(`<ellipse cx="${cx}" cy="${y + e}" rx="${rx}" ry="${e}" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.6"/>`);
  text(cx, cy + 4, lines, c.text, { sub });
}
function stack(cx, cy, w, h, c, lines, sub) {
  const shape = (x, y) => {
    const left = x - w / 2, top = y - h / 2, e = 8, rx = w / 2;
    parts.push(`<path d="M${left},${top + e} v${h - 2 * e} a${rx},${e} 0 0,0 ${w},0 v${-(h - 2 * e)}" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.4" stroke-opacity="0.7"/>`);
    parts.push(`<ellipse cx="${x}" cy="${top + e}" rx="${rx}" ry="${e}" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.4" stroke-opacity="0.7"/>`);
  };
  shape(cx + 12, cy - 12);
  shape(cx + 6, cy - 6);
  cyl(cx, cy, w, h, c, lines, sub);
}
function group(x, y, w, h, c, label) {
  parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="${c.fill}" fill-opacity="0.35" stroke="${c.stroke}" stroke-opacity="0.5" stroke-width="1.2" stroke-dasharray="5 4"/>`);
  parts.push(`<text x="${x + 16}" y="${y + 22}" font-size="13" font-weight="700" letter-spacing="0.6" fill="${c.stroke}">${esc(label.toUpperCase())}</text>`);
}
// An arrow along a path of points, with an optional label at a point.
function arrow(points, { label, at, both = false, dashed = false, bold = false, color = "#475569", anchor = "middle" } = {}) {
  const d = points.map((p, i) => `${i ? "L" : "M"}${p[0]},${p[1]}`).join(" ");
  parts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="${bold ? 3 : 1.7}" ${dashed ? 'stroke-dasharray="6 5"' : ""} marker-end="url(#${bold ? "headBold" : "head"})" ${both ? 'marker-start="url(#tail)"' : ""} stroke-linejoin="round"/>`);
  if (label) {
    const [lx, ly] = at;
    const w = label.length * 6.6 + 12;
    const x = anchor === "start" ? lx : anchor === "end" ? lx - w : lx - w / 2;
    parts.push(`<rect x="${x}" y="${ly - 10}" width="${w}" height="20" rx="10" fill="#ffffff" stroke="#e2e8f0"/>`);
    parts.push(`<text x="${x + w / 2}" y="${ly + 1}" font-size="12" fill="#334155" text-anchor="middle" dominant-baseline="middle">${esc(label)}</text>`);
  }
}

// Groups
group(20, 20, 220, 600, C.person, "You");
group(270, 20, 500, 600, C.app, "Scope Soup, on your laptop");
group(290, 380, 460, 160, C.git, "Scope Soup's working copies");
group(800, 20, 220, 600, C.remote, "Origin: the git server");

// Nodes
const board = [130, 110], mine = [130, 230], yours = [130, 560];
const server = [430, 110], orchestrator = [650, 110];
const claude = [600, 315];
const clone = [345, 465], work = [520, 465], queue = [675, 465];
const items = [910, 110], branches = [910, 330], main = [910, 560];

// Arrows first, so nodes sit on top. Labels sit on a straight part of their arrow, clear of boxes.
arrow([[board[0] + 75, board[1]], [server[0] - 60, server[1]]], { both: true, label: "view · answer · stop", at: [287, 88] });
arrow([[mine[0] + 75, mine[1] - 6], [server[0] - 20, server[1] + 24]], { label: "files and takes Items", at: [300, 182] });
arrow([[server[0] + 60, server[1]], [orchestrator[0] - 70, orchestrator[1]]], { both: true });
arrow([[orchestrator[0], orchestrator[1] - 24], [orchestrator[0], 62], [items[0], 62], [items[0], items[1] - 34]], { both: true, label: "syncs Items: meta branch or GitHub API", at: [760, 62] });
arrow([[orchestrator[0], orchestrator[1] + 24], [orchestrator[0], claude[1] - 25]], { label: "starts · watches · stops", at: [650, 210] });
arrow([[500, claude[1] + 25], [500, work[1] - 34]], { label: "commits", at: [500, 357] });
arrow([[clone[0] + 55, clone[1]], [work[0] - 60, work[1]]], { label: "makes", at: [430, 465] });
arrow([[565, work[1] - 32], [745, 360], [branches[0] - 75, branches[1]]], { label: "push", at: [655, 396] });
arrow([[branches[0] - 30, branches[1] + 32], [queue[0] + 40, queue[1] - 34]], { label: "batch", at: [790, 405] });
arrow([[queue[0] + 55, queue[1] + 10], [branches[0] - 60, main[1] - 14]], { bold: true, color: "#0f766e", label: "check passed · fast-forward", at: [770, 520] });
arrow([[main[0] - 65, main[1] + 10], [clone[0], main[1] + 10], [clone[0], clone[1] + 34]], { label: "fetch", at: [560, 570] });
arrow([[main[0] - 30, main[1] + 28], [main[0] - 30, 604], [yours[0] + 25, 604], [yours[0] + 25, yours[1] + 34]], { dashed: true, label: "you pull", at: [420, 604] });
arrow([[yours[0] - 30, yours[1] + 30], [yours[0] - 30, 640], [1030, 640], [1030, branches[1]], [branches[0] + 77, branches[1]]], { color: "#7c3aed", label: "your branch, pushed and handed back", at: [560, 640] });

// Nodes
box(...board, 150, 52, C.person, ["The board"], ["in your browser"]);
box(...mine, 150, 52, C.person, ["You + Claude"], ["plan and build with you"]);
cyl(...yours, 160, 68, C.person, ["Your clone"], ["Scope Soup never works here"]);
box(...server, 120, 48, C.app, ["Web server"], ["serves the board"]);
box(...orchestrator, 140, 48, C.app, ["The orchestrator"], ["runs the loop"]);
box(...claude, 250, 50, C.agent, ["Scope Soup's agents"], ["triage · implement · review · fix"]);
cyl(...clone, 120, 76, C.git, ["Main clone"], ["code + Items", "(meta branch)"]);
stack(...work, 120, 68, C.git, ["Work clones"], ["one per Item"]);
cyl(...queue, 110, 68, C.git, ["queue clone"], ["batches + check"]);
cyl(...items, 150, 64, C.remote, ["Items"], ["meta branch or Issues"]);
cyl(...branches, 150, 64, C.remote, ["Item branches"], ["scopesoup/<item>"]);
cyl(...main, 130, 56, C.remote, ["main"], ["always passes"]);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Segoe UI, -apple-system, Helvetica, Arial, sans-serif">
<defs>
  <marker id="head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#475569"/></marker>
  <marker id="tail" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#475569"/></marker>
  <marker id="headBold" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#0f766e"/></marker>
</defs>
<rect width="${W}" height="${H}" rx="18" fill="#ffffff"/>
${parts.join("\n")}
</svg>
`;
writeFileSync(out, svg);
console.log("wrote", out);
