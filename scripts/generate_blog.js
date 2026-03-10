#!/usr/bin/env node

/**
 * md-to-blog.js
 * Converts a Markdown blog post into Kanai's blog HTML style.
 *
 * Usage:
 *   node md-to-blog.js <input.md> [output.html]
 *
 * If output path is omitted, it writes to the same directory
 * as the input file with a .html extension.
 *
 * Dependencies:
 *   npm install marked
 */

const fs = require("fs");
const path = require("path");
const { marked } = require("marked");

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const [, , inputArg, outputArg] = process.argv;

if (!inputArg) {
  console.error("Usage: node md-to-blog.js <input.md> [output.html]");
  process.exit(1);
}

const inputPath = path.resolve(inputArg);

if (!fs.existsSync(inputPath)) {
  console.error(`Error: File not found – ${inputPath}`);
  process.exit(1);
}

const outputPath = outputArg
  ? path.resolve(outputArg)
  : inputPath.replace(/\.md$/i, ".html");

// ---------------------------------------------------------------------------
// Read & parse markdown
// ---------------------------------------------------------------------------

const rawMarkdown = fs.readFileSync(inputPath, "utf-8");

// Extract front-matter-style metadata from the top of the file.
// Supports a simple block like:
//
//   ---
//   title: My Post Title
//   date: 26th July, 2025
//   description: A short subtitle shown under the main heading.
//   ---
//
// Everything after the block is treated as the post body.

let title = path.basename(inputPath, path.extname(inputPath));
let date = "";
let description = "";
let bodyMarkdown = rawMarkdown;

const frontMatterMatch = rawMarkdown.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
if (frontMatterMatch) {
  const meta = frontMatterMatch[1];
  bodyMarkdown = frontMatterMatch[2];

  const pick = (key) => {
    const m = meta.match(new RegExp(`^${key}:\\s*(.+)$`, "im"));
    return m ? m[1].trim() : "";
  };

  title = pick("title") || title;
  date = pick("date");
  description = pick("description");
} else {
  // Fall back: use the first H1 as the title and strip it from the body
  const h1Match = rawMarkdown.match(/^#\s+(.+)$/m);
  if (h1Match) {
    title = h1Match[1].trim();
    bodyMarkdown = rawMarkdown.replace(h1Match[0], "").trimStart();
  }
}

// ---------------------------------------------------------------------------
// Custom marked renderer
// Transforms standard HTML output into Kanai's blog style classes.
// ---------------------------------------------------------------------------

const renderer = new marked.Renderer();

// ---------------------------------------------------------------------------
// Inline markdown helper — resolves **bold**, _italic_, `code`, links, etc.
// Declared here so every renderer below can use it.
// ---------------------------------------------------------------------------
function inline(text) {
  return marked.parseInline(text);
}

// Headings — generate slug IDs so TOC anchor links (#what-is-playwright) work
renderer.heading = ({ text, depth }) => {
  const sizes = {
    1: "text-3xl",
    2: "text-2xl",
    3: "text-xl",
    4: "text-lg",
    5: "text-base",
    6: "text-sm",
  };
  const size = sizes[depth] || "text-lg";
  // Strip any inline HTML tags from text before slugifying
  const plainText = text.replace(/<[^>]+>/g, "");
  const slug = plainText
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")   // remove punctuation
    .trim()
    .replace(/[\s]+/g, "-");    // spaces → hyphens
  return `<h${depth} id="${slug}" class="${size} font-serif my-6">${text}</h${depth}>\n`;
};

// Paragraphs — `text` from marked is already inline-parsed HTML, so bold/italic
// and inline code arrive pre-rendered. We just need to pass it through as-is.
renderer.paragraph = ({ text }) => {
  // Inline images inside a paragraph get their own centred wrapper
  if (text.trim().startsWith("<img")) {
    return `<div class="my-10">${text}</div>\n`;
  }
  return `<p class="text-lg font-serif mt-4">${text}</p>\n`;
};

// Images
renderer.image = ({ href, title: imgTitle, text: alt }) => {
  const caption = imgTitle
    ? `<p class="text-sm text-gray-500 text-center font-serif mt-2">${imgTitle}</p>`
    : "";
  return `<div class="my-10">
  <img src="${href}" alt="${alt}" class="w-full h-auto block" />
  ${caption}
</div>\n`;
};

// Code blocks → styled <details> collapsible with syntax highlighting via highlight.js
renderer.code = ({ text, lang }) => {
  const language = lang || "plaintext";
  // Escape HTML entities in the code
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  // Use a display label: e.g. "typescript" → "TypeScript"
  const label = language.charAt(0).toUpperCase() + language.slice(1);
  return `<details class="my-6 bg-gray-900 text-gray-100 rounded-lg overflow-x-auto">
  <summary class="p-4 cursor-pointer font-serif text-lg outline-none select-none">
    ${label} snippet
  </summary>
  <pre class="font-mono text-sm p-4 overflow-x-auto"><code class="hljs language-${language}">${escaped}</code></pre>
</details>\n`;
};

// Inline code
renderer.codespan = ({ text }) => {
  // Escape HTML entities so that backtick spans containing tag names like
  // `<script>` or `<link>` render as visible text, not real HTML elements.
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<code class="bg-gray-200 text-gray-800 font-mono text-sm px-1 py-0.5 rounded">${escaped}</code>`;
};

// Blockquotes
renderer.blockquote = ({ text }) => {
  return `<blockquote class="border-l-4 border-gray-400 pl-4 my-6 text-gray-600 font-serif text-lg italic">${inline(text)}</blockquote>\n`;
};

// Horizontal rules
renderer.hr = () => `<hr class="my-10" />\n`;

// Unordered lists
renderer.list = ({ items, ordered }) => {
  const tag = ordered ? "ol" : "ul";
  const style = ordered
    ? "list-decimal list-inside"
    : "list-disc list-inside";
  const inner = items.map((item) => renderer.listitem(item)).join("");
  return `<${tag} class="${style} font-serif text-lg my-4 space-y-1">${inner}</${tag}>\n`;
};

// listitem — placeholder; will be replaced below after inline() is available

// Links
renderer.link = ({ href, title: linkTitle, text }) => {
  const titleAttr = linkTitle ? ` title="${linkTitle}"` : "";
  return `<a href="${href}"${titleAttr} class="underline underline-offset-2 hover:text-gray-600 transition-colors">${text}</a>`;
};

// Strong / em — inner text may itself contain backticks or other inline syntax
renderer.strong = ({ text }) => `<strong class="font-bold">${inline(text)}</strong>`;
renderer.em = ({ text }) => `<em class="italic">${inline(text)}</em>`;

// Tables
renderer.table = ({ header, rows }) => {
  const headerHtml = header
    .map((cell) => `<th class="border border-gray-300 px-4 py-2 font-serif bg-gray-100">${inline(cell.text)}</th>`)
    .join("");
  const rowsHtml = rows
    .map(
      (row) =>
        `<tr>${row
          .map(
            (cell) =>
              `<td class="border border-gray-300 px-4 py-2 font-serif text-sm">${inline(cell.text)}</td>`
          )
          .join("")}</tr>`
    )
    .join("");
  return `<div class="overflow-x-auto my-6">
  <table class="w-full border-collapse text-left">
    <thead><tr>${headerHtml}</tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
</div>\n`;
};

marked.use({ renderer });

// Patch paragraph and listitem to run inline parsing
renderer.paragraph = (token) => {
  const processed = inline(token.text);
  if (processed.trim().startsWith("<img")) {
    return `<div class="my-10">${processed}</div>\n`;
  }
  return `<p class="text-lg font-serif mt-4">${processed}</p>\n`;
};

// listitem — walk token.tokens when present so text children are rendered
// via inline() and nested list children become a proper indented <ul>.
// Falling back to token.text only for simple items with no child tokens
// prevents the raw "- sub-item1 - sub-item2" text from leaking into the
// output alongside the nested list (the double-render bug).
renderer.listitem = (token) => {
  let body = '';

  if (token.tokens && token.tokens.length) {
    // Render each child token individually
    for (const child of token.tokens) {
      if (child.type === 'list') {
        // Nested sub-list → render as indented <ul>/<ol>
        const tag = child.ordered ? 'ol' : 'ul';
        const nestedItems = child.items
          .map((item) => renderer.listitem(item))
          .join('');
        body += `\n<${tag} class="list-disc ml-4 pl-4 mt-1 space-y-0.5 font-serif text-base">${nestedItems}</${tag}>`;
      } else {
        // Text / inline token → run through inline parser
        body += inline(child.text || child.raw || '');
      }
    }
  } else {
    // Simple list item with no child tokens
    body = inline(token.text || '');
  }

  return `<li class="text-lg font-serif">${body}</li>\n`;
};

// Re-apply renderer after patching
marked.use({ renderer });

const bodyHtml = marked.parse(bodyMarkdown);

// ---------------------------------------------------------------------------
// Build the full HTML page
// ---------------------------------------------------------------------------

const html = `<!DOCTYPE html>
<html lang="en">

<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <link rel="icon" href="assets/favicon.ico" type="image/x-icon" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Lexend:wght@100..900&display=swap" rel="stylesheet">
  <style type="text/tailwindcss">
    @theme {
      --font-sans: "Lexend", sans-serif;
      --font-serif: "Lexend", sans-serif;
    }
  </style>
  <script src="https://unpkg.com/@tailwindcss/browser@4"></script>
  <script src="https://polyfill.io/v3/polyfill.min.js?features=es6"></script>
  <script id="MathJax-script" async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>
  <!-- Syntax highlighting -->
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css" />
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
  <script>
    // Run highlight.js after page load; open <details> briefly so hljs can
    // reach the code, then restore closed state.
    document.addEventListener("DOMContentLoaded", () => {
      document.querySelectorAll("details").forEach(d => {
        const wasOpen = d.open;
        d.open = true;
        d.querySelectorAll("code.hljs").forEach(el => hljs.highlightElement(el));
        d.open = wasOpen;
      });
    });
  </script>
  <style>
    html {
      overflow: -moz-scrollbars-none;
      -ms-overflow-style: none;
      scrollbar-width: none;
    }
    html::-webkit-scrollbar { display: none; width: 0; height: 0; }
    body { -ms-overflow-style: none; scrollbar-width: none; overflow-y: scroll; }
    body::-webkit-scrollbar { display: none; width: 0; height: 0; }
  </style>
</head>

<body class="bg-orange-100 w-full max-w-[95%] md:w-[60%] mx-auto">

  <!-- ── Navigation ────────────────────────────────────────────────────── -->
  <nav class="mt-6">
    <div>
      <h1 class="font-serif text-4xl">Kanai's Blog</h1>
      <div class="mt-5 flex flex-wrap gap-5">
        <a href="/"
          class="relative after:content-[''] after:absolute after:w-0 after:h-[2px] after:bg-black after:bottom-[-4px] after:left-0 hover:after:w-full after:transition-all after:duration-300">Home</a>
        <a href="./blog.html"
          class="relative after:content-[''] after:absolute after:w-0 after:h-[2px] after:bg-black after:bottom-[-4px] after:left-0 hover:after:w-full after:transition-all after:duration-300">Blogs</a>
        <a href="../projects/projects.html"
          class="relative after:content-[''] after:absolute after:w-0 after:h-[2px] after:bg-black after:bottom-[-4px] after:left-0 hover:after:w-full after:transition-all after:duration-300">Projects</a>
        <a href="../prs/prs.html"
          class="relative after:content-[''] after:absolute after:w-0 after:h-[2px] after:bg-black after:bottom-[-4px] after:left-0 hover:after:w-full after:transition-all after:duration-300">Pull Requests</a>
        <a href="../gallery/gallery.html"
          class="relative after:content-[''] after:absolute after:w-0 after:h-[2px] after:bg-black after:bottom-[-4px] after:left-0 hover:after:w-full after:transition-all after:duration-300">Gallery</a>
      </div>
    </div>
  </nav>

  <hr class="mt-3" />

  <!-- ── Post header ───────────────────────────────────────────────────── -->
  <h1 class="text-4xl mt-[57px] mb-3 font-serif">${title}</h1>
  ${date ? `<span class="text-sm text-gray-500">${date}</span>` : ""}
  ${description ? `<p class="text-lg font-serif mt-4">${description}</p>` : ""}

  <!-- ── Post body ─────────────────────────────────────────────────────── -->
  ${bodyHtml}

  <!-- ── Footer ────────────────────────────────────────────────────────── -->
  <hr class="my-10" />
  <footer class="my-8">
    <div class="flex justify-between items-center">
      <p>By Kanai</p>
      <a href="https://buymeacoffee.com/Kanaixdev">BuyMeACoffee</a>
    </div>
  </footer>

</body>
</html>`;

// ---------------------------------------------------------------------------
// Write output
// ---------------------------------------------------------------------------

fs.writeFileSync(outputPath, html, "utf-8");
console.log(`✅  Converted: ${inputPath}`);
console.log(`📄  Output:    ${outputPath}`);