# Deep Dive into the Architecture of p5.js

> *A technical exploration of how one of the web's most beloved creative coding libraries is built — from its rendering pipeline and module system to its Friendly Error System and WebGL internals.*

---

## Table of Contents

1. [What is p5.js?](#what-is-p5js)
2. [Repository Structure](#repository-structure)
3. [Core Architecture: The p5 Object Model](#core-architecture-the-p5-object-model)
4. [Global Mode vs. Instance Mode](#global-mode-vs-instance-mode)
5. [The Sketch Lifecycle](#the-sketch-lifecycle)
6. [Module System and Build Pipeline](#module-system-and-build-pipeline)
7. [The Rendering Architecture](#the-rendering-architecture)
8. [WebGL Mode Internals](#webgl-mode-internals)
9. [The Friendly Error System (FES)](#the-friendly-error-system-fes)
10. [The Addon/Extension System](#the-addonextension-system)
11. [p5.js 2.0: A Paradigm Shift](#p5js-20-a-paradigm-shift)
12. [Internationalization (i18n)](#internationalization-i18n)
13. [Testing Infrastructure](#testing-infrastructure)
14. [Key Design Principles](#key-design-principles)
15. [Conclusion](#conclusion)

---

## What is p5.js?

p5.js is a client-side JavaScript library that reinterprets the creative coding philosophy of [Processing](https://processing.org/) for the modern web. Rather than a port of Processing's Java syntax, p5.js is a native JavaScript library built on the HTML5 Canvas API and WebGL, designed to make coding accessible to artists, designers, educators, and beginners.

The project is maintained by the [Processing Foundation](https://processingfoundation.org/) and powered largely by volunteers. As of early 2026, the library is at version **2.x** (latest: 2.2.2), representing a significant architectural overhaul from 1.x.

---

## Repository Structure

The `processing/p5.js` GitHub repository follows a well-organized monorepo layout:

```
p5.js/
├── src/                    # All source code
│   ├── core/               # p5 class, lifecycle, environment
│   │   ├── friendly_errors/    # Friendly Error System (FES)
│   │   ├── constants.js
│   │   ├── environment.js
│   │   ├── p5.js           # The main p5 constructor
│   │   └── rendering.js
│   ├── color/              # Color parsing and management
│   ├── data/               # Data structures (Table, TypedDict)
│   ├── dom/                # DOM interaction utilities
│   ├── events/             # Mouse, keyboard, touch events
│   ├── image/              # Image loading, pixels, filters
│   ├── io/                 # File I/O, HTTP, table loading
│   ├── math/               # Vectors, noise, trigonometry
│   ├── typography/         # Text rendering, font loading
│   ├── utilities/          # Time, array, string helpers
│   ├── webgl/              # WebGL renderer, shaders, 3D geometry
│   └── app.js              # Top-level entry point
├── test/                   # Unit and integration tests
├── contributor_docs/        # Architecture docs for contributors
├── translations/           # i18n JSON files for FES messages
├── Gruntfile.js            # Build tasks (legacy)
├── rollup.config.js        # Module bundling configuration
└── package.json
```

Each folder under `src/` typically maps directly to a conceptual domain of the library. This **domain-driven layout** makes it easy for contributors to find and reason about specific functionality.

---

## Core Architecture: The p5 Object Model

At its heart, p5.js is built around a single class — **`p5`**. This class is the sketch instance and holds all state: canvas references, rendering context, frame count, environment variables, and all the drawing functions the user calls.

### Constructor Flow

When `new p5(sketch)` is called (or when the library initializes in global mode), here is roughly what happens:

```js
// Simplified constructor logic
function p5(sketch, node) {
  this._initializeInstanceVariables();   // Sets defaults (frameCount=0, etc.)
  this._createRenderer();                // Creates p5.Renderer2D or p5.RendererGL
  this._bindHelperMethods();             // Attaches all prototype methods
  if (sketch) sketch(this);             // Runs user's sketch function
  this._setup();                         // Calls user's setup()
  this._runDrawLoop();                   // Starts requestAnimationFrame loop
}
```

### Prototype Extension Pattern

All drawing functions — `rect()`, `ellipse()`, `fill()`, etc. — are attached to `p5.prototype` by each module when it is loaded. This is the foundational extensibility mechanism:

```js
// In src/shape/2d_primitives.js
p5.prototype.rect = function(x, y, w, h, ...) {
  this._renderer.rect([x, y, w, h, ...]);
  return this;
};
```

This pattern means every sketch instance automatically gets all functions, and addon libraries can add new methods by extending `p5.prototype` (or, in 2.0, via `fn` inside `registerAddon`).

---

## Global Mode vs. Instance Mode

p5.js supports two operating modes, which affects how the sketch interacts with the browser's global scope.

### Global Mode

This is the default, beginner-friendly mode. When p5.js detects `setup` or `draw` on the global (`window`) object, it creates a sketch automatically and maps all p5 functions to the global namespace:

```js
// Global mode — functions are available globally
function setup() {
  createCanvas(400, 400);
}

function draw() {
  background(200);
  circle(mouseX, mouseY, 50);
}
```

Internally, p5.js reflects all prototype methods onto `window`, meaning calls to `rect()` become `window.p5Instance.rect()` behind the scenes.

### Instance Mode

Instance mode gives the developer full control and avoids polluting the global namespace — essential when embedding multiple sketches on a page or integrating with frameworks like React:

```js
const sketch = (p) => {
  p.setup = () => {
    p.createCanvas(400, 400);
  };
  p.draw = () => {
    p.background(200);
    p.circle(p.mouseX, p.mouseY, 50);
  };
};

const mySketch = new p5(sketch, document.getElementById('canvas-container'));
```

All functions and properties are scoped to `p`, the sketch instance. This is the pattern recommended for production use.

---

## The Sketch Lifecycle

Understanding p5.js's lifecycle is key to understanding its architecture. Here is the full lifecycle of a sketch:

```
Library Load
     │
     ▼
[1] preload()   ← Asset loading (1.x) / async setup (2.x)
     │
     ▼
[2] setup()     ← One-time initialization, createCanvas()
     │
     ▼
[3] draw()      ← Called repeatedly (requestAnimationFrame)
     │           ← Runs at targetFrameRate (default 60fps)
     │
     ▼
[4] remove()    ← Cleanup, stops draw loop, removes canvas
```

### The Draw Loop

The draw loop is implemented via `requestAnimationFrame` (rAF). The `p5.prototype.redraw()` function is the core of this mechanism:

```js
p5.prototype._runFrames = function() {
  if (this._drawInterval) {
    clearInterval(this._drawInterval);
  }
  // requestAnimationFrame-based loop
  this._loop();
};
```

Frame rate is controlled by throttling rAF calls — if the target frame rate is 30fps, the loop only actually calls `draw()` every other rAF tick.

### Asset Loading: preload() vs. async/await

In **p5.js 1.x**, asset loading used a custom synchronization mechanism based on reference counting:
- `_incrementPreload()` was called each time a load function (e.g., `loadImage()`) was invoked.
- `_decrementPreload()` was called when loading completed.
- `draw()` would not start until the count reached zero.

In **p5.js 2.x**, this has been replaced with native JavaScript `async/await`, reflecting modern web standards. `setup()` can now be async:

```js
// p5.js 2.x
async function setup() {
  createCanvas(400, 400);
  let img = await loadImage('photo.jpg');
  image(img, 0, 0);
}
```

The old `preload()` pattern is still available via a **compatibility addon** to ease migration.

---

## Module System and Build Pipeline

### Source Modules (ESM)

p5.js source code is written as **ES Modules (ESM)**. Each module exports a function that, when called, attaches functionality to `p5.prototype`. The top-level `src/app.js` imports and wires them all together:

```js
// src/app.js (simplified)
import './color/color_conversion';
import './color/creating_reading';
import './core/environment';
import './shape/2d_primitives';
import './math/calculation';
import './webgl/p5.RendererGL';
// ... many more
```

### Rollup Bundling

p5.js uses [Rollup](https://rollupjs.org/) to bundle its ESM source into distributable formats. Two key output formats are produced:

**IIFE (Immediately Invoked Function Expression)** — for use with `<script>` tags in HTML:
```html
<script src="p5.js"></script>
```

**ESM** — for use with modern bundlers (Webpack, Vite) and `import` statements:
```js
import p5 from 'p5';
```

In p5.js 2.0, the modular architecture goes further: individual modules (like `p5/math`) can be imported and registered separately, enabling much smaller bundle sizes for projects that don't need the full library.

### Build Artifacts

| File | Description |
|---|---|
| `p5.js` | Full unminified build (includes FES) |
| `p5.min.js` | Minified build (FES stripped for performance) |
| `p5.esm.js` | ESM build for modern toolchains |
| `p5.math.esm.js` | Example of standalone modular build (2.x) |

---

## The Rendering Architecture

p5.js maintains a clean abstraction between the high-level drawing API and the low-level rendering backend via a **renderer class hierarchy**:

```
p5.Renderer (base class)
├── p5.Renderer2D    ← Wraps the browser's CanvasRenderingContext2D
└── p5.RendererGL    ← Wraps WebGL1/WebGL2
```

### p5.Renderer2D

`p5.Renderer2D` delegates directly to the browser's built-in 2D canvas context. It is relatively shallow — most p5.js drawing calls map nearly 1:1 to Canvas API calls:

```js
// src/core/p5.Renderer2D.js (simplified)
p5.Renderer2D.prototype.rect = function(args) {
  const ctx = this.drawingContext; // CanvasRenderingContext2D
  ctx.beginPath();
  ctx.rect(args[0], args[1], args[2], args[3]);
  this._doFillStrokeClose(closeShape);
};
```

2D mode call stacks are shallow because p5.js largely passes commands through to the browser API, which handles rendering natively.

### p5.RendererGL

The WebGL renderer is significantly more complex. Because WebGL operates at a much lower level than the 2D Canvas API, `p5.RendererGL` must:

1. **Tesselate shapes into triangles** — the GPU only knows about triangles
2. **Manage vertex buffers** (VBOs) and upload geometry data to the GPU
3. **Compile and link GLSL shaders** for fills, strokes, and materials
4. **Maintain a matrix stack** for 3D transforms
5. **Cache geometry** for performance via `p5.Geometry`

### The Geometry Pipeline

p5.js 2.x introduced a cleaner separation between **immediate mode** and **retained mode** geometry:

**Immediate mode** — shapes drawn frame-by-frame, geometry computed each call:
```js
function draw() {
  sphere(50); // Recalculates triangle data every frame
}
```

**Retained mode** — geometry cached in a `p5.Geometry` object and reused:
```js
let myGeo;
function setup() {
  myGeo = buildGeometry(() => {
    sphere(50);
    box(30);
  });
}
function draw() {
  model(myGeo); // Reuses cached GPU buffers — much faster
}
```

`p5.Geometry` stores triangle data and tracks its associated GPU-side buffers. Calling `freeGeometry()` clears GPU memory. The key class internals look like:

```js
class p5.Geometry {
  vertices: []      // Array of p5.Vector
  faces: []         // Triangle indices
  uvs: []           // Texture coordinates
  vertexNormals: [] // For lighting calculations
  _buffers: {}      // GPU-side WebGLBuffer references
}
```

### Shader System

Every shape rendered in WebGL mode uses exactly one shader for its **fills** and one for its **strokes**. p5.js ships with several built-in shader programs:

- **Color shader** — flat, unlit color
- **Lighting shader** — Phong shading with ambient/directional/point lights
- **Texture shader** — for image-mapped surfaces
- **Line shader** — special geometry-based line rendering (not GL_LINES)
- **Normal shader** — visualizes surface normals (debug)

Users can supply custom GLSL shaders via `createShader()` and `shader()`. A design goal for p5.js 2.x is to allow custom shaders to **import fragments** of the built-in shaders (e.g., reuse the lighting equations) without copy-pasting — currently a known limitation.

---

## WebGL Mode Internals

The WebGL architecture is the most complex part of the codebase. Here is a tour of its key components:

### State Management

`p5.RendererGL` maintains an internal state object that mirrors WebGL's own state machine. This includes current fill color, stroke weight, active shader, blend mode, matrix stack, and more. Before each draw call, the renderer checks which state has changed and issues only the minimum necessary WebGL calls.

### Matrix Stack

3D transforms are managed through a matrix stack:

```
push()    → pushes a copy of the current transform matrix
pop()     → restores the previous matrix
translate(x, y, z) → multiplies the current matrix by a translation
rotate(angle, axis) → multiplies by a rotation matrix
scale(x, y, z)      → multiplies by a scale matrix
```

The current transformation matrix is uploaded to the vertex shader as a uniform (`uModelViewMatrix`) before each draw call.

### Camera and Projection

p5.js WebGL mode provides both **perspective** (`perspective()`) and **orthographic** (`ortho()`) projection modes. Internally these manipulate the projection matrix uniform (`uProjectionMatrix`) sent to the shader.

### Line Rendering

One distinctive design choice in p5.js's WebGL mode is how strokes/lines are rendered. Rather than using `GL_LINES` (which has poor cross-browser support for thick lines), p5.js generates **geometry** for lines — each line segment becomes a set of triangles forming a rectangle, capped appropriately. This is more expensive but produces consistent, high-quality results across all devices.

This is also one of the most common performance bottlenecks, and a fast "simple line" mode was introduced in 2.x for cases where visual quality can be traded for speed.

### Off-screen Rendering

`createGraphics(w, h, WEBGL)` creates a `p5.Graphics` object, which is essentially a separate `p5.RendererGL` instance backed by a WebGL framebuffer. The result can be used as a texture on 3D geometry or blitted onto the main canvas.

---

## The Friendly Error System (FES)

One of p5.js's most distinctive architectural features is its **Friendly Error System** (FES), identifiable by its 🌸 icon in the console. The FES is designed to lower the barrier to debugging for beginners by translating cryptic browser error messages into plain language.

### Architecture

The FES lives in `src/core/friendly_errors/` and is composed of several files:

```
friendly_errors/
├── fes_core.js          # _report(), _friendlyError(), _friendlyAutoplayError()
├── validate_params.js   # _validateParameters() — type checking
├── file_errors.js       # _friendlyFileLoadError()
└── sketch_reader.js     # Reads sketch source to provide line-number context
```

### Key Functions

**`p5._friendlyError(msg, fn, color)`** — the primary display function. Formats a message and logs it to the console with the `🌸 p5.js says:` prefix.

**`p5._validateParameters(funcName, args)`** — validates function arguments against inline JSDoc type annotations. For every function call, it:
1. Looks up the parameter documentation (parsed at build time from JSDoc comments)
2. Checks the number and types of supplied arguments
3. Reports specific, actionable errors if mismatches are found

```
🌸 p5.js says: [sketch.js, line 13] arc() was expecting at
   least 6 arguments, but received only 4.
```

**`p5._friendlyFileLoadError(errorType, filePath)`** — triggered by failed asset loads from `loadImage()`, `loadFont()`, `loadJSON()`, etc. Provides the incorrect path and links to troubleshooting resources.

**`p5._friendlyAutoplayError()`** — helps users understand browser autoplay policies that block audio.

### Performance Considerations

Parameter validation at every function call would be prohibitively expensive. The FES uses several strategies to manage this:

- **Build-time extraction**: Parameter type information is extracted from JSDoc comments during the build process and compiled into a compact lookup structure.
- **p5.min.js disables FES entirely**: The production-minified build strips all FES code, so end-users of deployed sketches do not pay any performance cost.
- **`p5.disableFriendlyErrors = true`**: Developers can opt out of FES in development if needed.

### Internationalization in FES

All FES messages are generated through an `i18next`-based `translator()` function. Error message strings are stored in `translations/en/translation.json` (and equivalent files for other languages), allowing the FES to display errors in the user's language.

---

## The Addon/Extension System

### p5.js 1.x: Prototype Extension

In p5.js 1.x, addons extended the library by directly modifying `p5.prototype`:

```js
// p5.js 1.x addon pattern
p5.prototype.myNewFunction = function() {
  // ...
};

// Hooking into lifecycle events
p5.prototype.mySetup = function() { /* ... */ };
p5.prototype.registerMethod('beforeSetup', p5.prototype.mySetup);
```

This worked, but it was fragile — addons could accidentally overwrite each other's methods, and there was no standardized discovery or lifecycle API.

### p5.js 2.x: `registerAddon()`

p5.js 2.0 introduces a first-class `p5.registerAddon()` API that provides a clean, safe contract between the core library and its extensions. Every module inside p5.js itself uses this same API, unifying internal and external extension:

```js
// p5.js 2.x addon structure
const myAddon = function(p5, fn, lifecycles) {
  // fn is p5.prototype — attach new methods here
  fn.myNewFunction = function(x, y) {
    // 'this' is the sketch instance
    this._renderer.drawSomething(x, y);
  };

  // Lifecycle hooks
  lifecycles.presetup = function() {
    // Runs before setup(), 'this' is sketch instance
  };

  lifecycles.predraw = function() {
    // Runs before each draw() call
  };
};

p5.registerAddon(myAddon);
```

### Available Lifecycle Hooks

| Hook | When it fires |
|---|---|
| `presetup` | Immediately before `setup()` |
| `postsetup` | Immediately after `setup()` |
| `predraw` | Before each `draw()` call |
| `postdraw` | After each `draw()` call |
| `remove` | When `remove()` is called |

### Module Composition (2.x Internal Architecture)

The new addon system allows the p5.js core itself to be split into composable modules. Each sub-module registers itself using the same `registerAddon` pattern:

```js
// src/math/index.js
import calculation from './calculation.js';
import noise from './noise.js';
import random from './random.js';

export default function(p5, fn) {
  p5.registerAddon(calculation);
  p5.registerAddon(noise);
  p5.registerAddon(random);
}

// src/math/calculation.js
function calculation(p5, fn) {
  fn.abs = Math.abs;
  fn.ceil = Math.ceil;
  // ...
}
export default calculation;

// Self-register if p5 is already loaded (CDN usage)
if (typeof p5 !== 'undefined') {
  calculation(p5, p5.prototype);
}
```

This enables both tree-shaking (for bundler users) and selective CDN loading.

---

## p5.js 2.0: A Paradigm Shift

p5.js 2.0 is not a minor version bump — it represents a deep architectural rethink motivated by years of feedback. Here are the most significant changes:

### 1. Async/Await Replaces preload()

The custom preload counter mechanism is gone. `setup()` is now natively async, and all `load*` functions return Promises:

```js
// 2.x — idiomatic async/await
async function setup() {
  createCanvas(400, 400);
  const font = await loadFont('OpenSans.ttf');
  const data = await loadJSON('data.json');
  // All loaded before draw() starts
}
```

This aligns p5.js with how JavaScript actually works, making it easier to transfer skills to general web development.

### 2. Modular Build System

The codebase has been refactored into modular pieces that can be imported independently. This enables much smaller bundle sizes for projects that only use a subset of p5.js's functionality.

### 3. Performance Improvements

- ~350% faster `textToPoints()` for 3D text extrusion
- Fast simple-line rendering mode in WebGL
- 2D mode filter shaders without loading the full WebGL module
- New public `Matrix` class with pluggable underlying math backends

### 4. Color Space Support

The color module was refactored to support many more color spaces beyond RGB and HSB, including `oklch`, `display-p3`, and others defined in CSS Color Level 4.

### 5. Compatibility Addons

To ease migration, breaking changes are packaged as opt-in **compatibility addons**:

- `preload.js` — restores `preload()` behavior for sketches not yet migrated to async
- `shapes.js` — restores 1.x shape drawing API
- Various removed utility functions (replaced by native JS equivalents)

### 6. Typography Refactor

The typography system was rebuilt to be smaller, support variable fonts (OpenType fvar), and provide more precise text measurement — critical for accessibility and layout-sensitive applications.

---

## Internationalization (i18n)

p5.js has a deep commitment to internationalization, particularly within the FES. The translation system is built on [i18next](https://www.i18next.com/).

**Translation files** live in `translations/{locale}/translation.json`. Each key maps to a message template:

```json
{
  "fes": {
    "friendlyParamError": {
      "type_wrong": "{{name}}() was expecting {{type}} for parameter #{{position}}, received {{received}} instead."
    }
  }
}
```

The `translator(key, interpolation)` function resolves the correct locale at runtime and formats the message. This means all error messages — not just UI text — are translatable, a relatively rare design choice in JavaScript libraries.

---

## Testing Infrastructure

p5.js uses a combination of **Mocha** (test runner) and **Chai** (assertions) for unit and integration testing. Tests live in the `test/` directory, mirroring the `src/` structure.

### Test Categories

**Unit tests** — test individual functions in isolation:
```js
describe('p5.prototype.abs', function() {
  it('should return the absolute value', function() {
    assert.equal(myp5.abs(-5), 5);
  });
});
```

**Visual tests** — render a sketch and compare pixels against a reference image (snapshot testing). Critical for verifying renderer behavior.

**FES tests** — verify that specific incorrect inputs produce specific friendly error messages.

### Test Execution

Tests are run both in the browser (via an HTML test runner) and in Node.js (for CI pipelines). The project uses GitHub Actions for continuous integration, running the full test suite on every pull request.

A key challenge is that WebGL tests require a real GPU context. In CI environments, this is handled via headless browser automation.

---

## Key Design Principles

Several architectural decisions in p5.js reflect its core values:

### 1. Beginner-friendliness as a First-Class Constraint

Every API decision considers whether a beginner could understand it. The FES, the `preload()` function (and now `async setup()`), the global mode — all exist to minimize the gap between "I have an idea" and "I have code that works."

### 2. Accessibility Over Features

p5.js 2.0 formalized a principle: **no new features will be added unless they increase access**. The focus is on making the existing feature set work better for more people, rather than expanding scope.

### 3. Separation of Concerns via the Renderer Abstraction

The `p5.Renderer` base class ensures that user code doesn't need to know whether it's running in 2D or WebGL mode. Both renderers expose the same high-level API (`rect()`, `fill()`, `push()`/`pop()`), allowing sketches to switch modes with minimal code changes.

### 4. Modularity Without Complexity

The module system in 2.x achieves a delicate balance: the library is internally modular (enabling tree-shaking and smaller bundles) but the user-facing API remains simple and monolithic by default. Users who just want `<script src="p5.js">` still get a single file that works.

### 5. Open Source as Community Practice

p5.js views open source not just as a licensing choice but as a social practice. The contributor guidelines, steward system (domain-specific maintainers), AI usage policy, and code of conduct are all first-class parts of the codebase.

---

## Conclusion

p5.js is a fascinating case study in open-source library architecture. Beneath its beginner-friendly surface lies a thoughtful system of renderer abstraction, prototype-based extension, a custom error assistance layer, and — in 2.x — a modular addon architecture that unifies how internal and external extensions are built.

The evolution from 1.x to 2.x mirrors broader shifts in the JavaScript ecosystem: the move from custom async patterns to native Promises, from global-scope monoliths to modular ESM packages, and from UMD bundles to Rollup-optimized IIFE and ESM outputs.

For anyone interested in creative coding, browser rendering, or the design of accessible developer tools, the p5.js codebase is an excellent read — not just for what it does, but for the care it takes in *how* it does it.

---

### Further Reading

- [p5.js GitHub Repository](https://github.com/processing/p5.js)
- [WebGL Mode Architecture (Contributor Docs)](https://p5js.org/contribute/webgl_mode_architecture/)
- [Friendly Error System (Contributor Docs)](https://p5js.org/contribute/friendly_error_system/)
- [p5.js 2.0 RFC: Functional Core and Modular Build](https://github.com/processing/p5.js/issues/7014)
- [Designing an Addon Library System for p5.js 2.0](https://dev.to/limzykenneth/designing-an-addon-library-system-for-p5js-20-3d4p)
- [p5.js 2.0 and Open Source Philosophy — Dave Pagurek](https://www.davepagurek.com/blog/p5-2.0-philosophy/)