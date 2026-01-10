import { parseHTML } from "npm:linkedom/worker";

import { parse } from "npm:@babel/parser";
// @ts-types="npm:@types/babel-traverse"
import _traverse from "npm:@babel/traverse";
// @ts-types="npm:@types/babel-types"
import type { Expression, Node } from "npm:@babel/types";
// @ts-types="npm:@types/babel-generator"
import _generate from "npm:@babel/generator";

const traverse = (_traverse as any).default || _traverse;
const generate = (_generate as any).default || _generate;

/**
 * Tagged template function type for building HTML strings.
 * Automatically handles nested Renderable components by calling their render method.
 */
type Html = (strings: TemplateStringsArray, ...values: unknown[]) => string;

interface RenderContext {
  html: Html;
  req: Request;
}

/**
 * Any class that can be rendered to HTML.
 * Optionally tracks reactive signals for state management.
 */
interface Renderable {
  render: (ctx: RenderContext) => string;
  signals?: Record<string | symbol, unknown>;
}

const astCache = new WeakMap<Function, any>();

function getAst(renderFn: Function) {
  if (astCache.has(renderFn)) {
    return astCache.get(renderFn);
  }

  const ast = parse(`class Temp { ${renderFn.toString()} }`, {
    sourceType: "module",
    plugins: ["typescript", "decorators"],
  });

  astCache.set(renderFn, ast);
  return ast;
}

interface ExprAnalysis {
  signals: string[];
  writes: string[];
  isFunction: boolean;
  isEvent: boolean;
  eventName: string | null;
  source: string;
  bodySource: string | null;
}
type RenderFn = (ctx: RenderContext) => string;
export function analyzeRender(renderFn: RenderFn): ExprAnalysis[] {
  const ast = parse(`class Temp { ${renderFn.toString()} }`, {
    sourceType: "module",
    plugins: ["typescript", "decorators"],
  });

  const results: ExprAnalysis[] = [];

  traverse(ast, {
    TaggedTemplateExpression(path: any) {
      const node = path.node;
      if (node.tag?.name !== "html") return;

      const quasis = node.quasi.quasis;
      const expressions = node.quasi.expressions;

      expressions.forEach((expr: any, i: number) => {
        const signals: string[] = [];
        const writes: string[] = [];

        const isFunction = expr.type === "ArrowFunctionExpression" ||
          expr.type === "FunctionExpression";

        traverse(
          ast, // traverse needs the root, we filter by checking we're inside expr
          {
            MemberExpression(innerPath: any) {
              // Only process if we're inside this specific expression
              if (!isDescendant(innerPath.node, expr)) return;

              const innerNode = innerPath.node;
              if (innerNode.object?.type === "ThisExpression") {
                const name: string = innerNode.property?.name;
                if (!name) return;

                const parent = innerPath.parent;
                const isWrite = parent?.type === "UpdateExpression" ||
                  (parent?.type === "AssignmentExpression" &&
                    parent.left === innerNode);

                if (isWrite) writes.push(name);
                signals.push(name);
              }
            },
          },
          path.scope,
        );

        const before: string = quasis[i].value.raw;
        const eventMatch = before.match(/\s(on\w+)=\s*$/);

        results.push({
          signals,
          writes,
          isFunction,
          isEvent: isFunction && !!eventMatch,
          eventName: eventMatch?.[1] || null,
          source: generate(expr).code,
          bodySource: isFunction ? generate(expr.body).code : null,
        });
      });
    },
  });

  return results;
}

function isRenderable(value: unknown): value is Renderable {
  return (
    typeof value === "object" &&
    value !== null &&
    "render" in value &&
    typeof (value as Renderable).render === "function"
  );
}

// Helper to check if a node is inside another
function isDescendant(node: any, ancestor: any): boolean {
  if (!node || !ancestor) return false;
  if (node.start >= ancestor.start && node.end <= ancestor.end) return true;
  return false;
}
interface Binding {
  id: string;
  signals: string[];
  source: string;
}

interface Handler {
  id: string;
  event: string;
  source: string;
  writes: string[];
}

export function generateScript(
  instance: Renderable,
  bindings: Binding[],
  handlers: Handler[],
): string {
  const ATTR = "data-zid";

  const allSignals = new Set<string>();
  bindings.forEach((b) => b.signals.forEach((s) => allSignals.add(s)));
  handlers.forEach((h) => h.writes.forEach((s) => allSignals.add(s)));

  let script = "\n<script>\n(function() {\n";

  for (const signal of allSignals) {
    script += `  let ${signal} = ${
      JSON.stringify((instance as any)[signal])
    };\n`;
  }

  const allIds = [
    ...new Set([...bindings.map((b) => b.id), ...handlers.map((h) => h.id)]),
  ];
  for (const id of allIds) {
    script += `  const ${id} = document.querySelector('[${ATTR}="${id}"]');\n`;
  }

  script += `  function __update() {\n`;
  for (const b of bindings) {
    const expr = b.source.replace(/this\./g, "");
    script += `    ${b.id}.textContent = ${expr};\n`;
  }
  script += `  }\n`;

  for (const h of handlers) {
    const body = h.source.replace(/this\./g, "");
    script += `  ${h.id}.${h.event} = () => { ${body}; __update(); };\n`;
  }

  script += "})();\n</script>";

  return script;
}

const ATTR = "data-zid"; // or whatever you want to call your framework

export function createHtmlFactory(
  page: Renderable,
  ctx: Omit<RenderContext, "html">,
  idCounter: { value: number } = { value: 0 },
): Html {
  const analysis = analyzeRender(page.render);

  const bindings: Binding[] = [];
  const handlers: Handler[] = [];
  const elementIds: Map<unknown, string> = new Map();

  const html: Html = (strings: TemplateStringsArray, ...values: unknown[]) => {
    let rawHtml = "";
    const placeholders: Map<string, { value: unknown; expr: ExprAnalysis }> =
      new Map();

    for (let i = 0; i < strings.length; i++) {
      rawHtml += strings[i];

      if (i < values.length) {
        const value = values[i];
        const expr = analysis[i];

        if (isRenderable(value)) {
          const childHtml = createHtmlFactory(value, ctx, idCounter);
          const childContent = value.render({ html: childHtml, ...ctx });
          rawHtml += childContent;
        } else if (Array.isArray(value)) {
          for (const item of value) {
            if (isRenderable(item)) {
              const childHtml = createHtmlFactory(item, ctx, idCounter);
              rawHtml += item.render({ html: childHtml, ...ctx });
            } else {
              rawHtml += String(item ?? "");
            }
          }
        } else {
          const placeholder = `__PLACEHOLDER_${i}__`;
          placeholders.set(placeholder, { value, expr });
          rawHtml += placeholder;
        }
      }
    }

    // deno-lint-ignore no-explicit-any
    const { document } = parseHTML(
      `<div id="__root__">${rawHtml}</div>`,
    ) as any;
    const root = document.getElementById("__root__")!;

    // 1. FIRST: Process events and collect writes
    const writtenSignals = new Set<string>();

    // deno-lint-ignore no-explicit-any
    const allElements: any[] = Array.from(root.querySelectorAll("*") as any);
    for (const el of allElements) {
      for (const attr of [...el.attributes]) {
        for (const [placeholder, { expr }] of placeholders) {
          if (attr.value === placeholder && expr?.isEvent) {
            let id = elementIds.get(el);
            if (!id) {
              id = `_${idCounter.value++}`;
              el.setAttribute(ATTR, id);
              elementIds.set(el, id);
            }
            el.removeAttribute(attr.name);

            // Track writes
            expr.writes.forEach((w: string) => writtenSignals.add(w));

            handlers.push({
              id,
              event: attr.name,
              source: expr.bodySource!,
              writes: expr.writes,
            });
          }
        }
      }
    }

    // 2. THEN: Process text nodes, knowing which signals are written
    const walker = document.createTreeWalker(root, 4);
    // deno-lint-ignore no-explicit-any
    const textNodes: any[] = [];
    while (walker.nextNode()) {
      textNodes.push(walker.currentNode);
    }

    for (const textNode of textNodes) {
      let text = textNode.textContent || "";

      for (const [placeholder, { value, expr }] of placeholders) {
        if (!text.includes(placeholder)) continue;

        const isReactive = expr?.signals.some((s: string) =>
          writtenSignals.has(s)
        );

        if (isReactive) {
          const parent = textNode.parentElement;
          let id = elementIds.get(parent);
          if (!id) {
            id = `_${idCounter.value++}`;
            parent.setAttribute(ATTR, id);
            elementIds.set(parent, id);
          }
          text = text.replace(placeholder, String(value));
          textNode.textContent = text;
          bindings.push({
            id,
            signals: expr.signals,
            source: expr.source,
          });
        } else {
          text = text.replace(placeholder, String(value ?? ""));
          textNode.textContent = text;
        }
      }
    }

    let result = root.innerHTML;

    // 3. Only generate script if there's reactivity
    if (handlers.length > 0 || bindings.length > 0) {
      result += generateScript(page, bindings, handlers);
    }

    return result;
  };

  return html;
}

function injectId(html: string, id: string): string {
  return html.replace(/<(\w+)([^>]*)$/, `<$1 id="${id}"$2`);
}

// deno-lint-ignore no-explicit-any
type RenderableClass = new (...args: any[]) => Renderable;

class App {
  pages: Record<string, RenderableClass> = {};

  /**
   * Class decorator that registers a page component at the given URL path.
   * @example
   * @app.route("/dashboard")
   * class Dashboard { ... }
   */
  route(path: string) {
    return <T extends RenderableClass>(
      value: T,
      _context: ClassDecoratorContext,
    ) => {
      const ModifiedClass = class extends value {
        path = path;
        // deno-lint-ignore no-explicit-any
        constructor(...args: any[]) {
          super(...args);
        }
      };
      this.pages[path] = ModifiedClass;
      return ModifiedClass;
    };
  }

  /**
   * Field decorator that marks a class property as reactive state.
   * Decorated fields are tracked in the component's `signals` map.
   * @example
   * class Counter {
   *   @app.signal count = 0;
   * }
   */
  // signal(_value: undefined, { kind, name }: ClassFieldDecoratorContext) {
  //   if (kind === "field") {
  //     return function <V>(this: Renderable, initialValue: V) {
  //       this.signals ??= {};
  //       this.signals[name] = initialValue;
  //       return initialValue;
  //     };
  //   }
  // }
}

const app = new App();

@app.route("/hello/world")
class Index {
  render({ html, req }: RenderContext) {
    return html`<html lang="en">
      <head>
        <meta charset="UTF-8" />
        <title>Document</title>
      </head>
      <body>
        <h1>${req.url}</h1>
        ${new Counter({ initial: 5 })}
        ${new List()}
      </body>
    </html>`;
  }
}

class List {
  // @app.signal count = 0;
  list = ["a", "b", "c"];

  render({ html }: RenderContext) {
    return html`<ul>${
      this.list.map((element) => html`<li>${element}</li>`)
    }</ul>`;
  }
}

class Counter {
  // @app.signal count = 0;
  count = 0;

  constructor(props: { initial: number }) {
    this.count = props.initial;
  }

  render({ html }: RenderContext) {
    return html`<button onclick=${() => this.count++}>${this.count}</button>`;
  }
}

// Route incoming requests to registered page components
Deno.serve((req) => {
  const url = new URL(req.url);
  const Page = app.pages[url.pathname];
  const page = new Page();
  const html = createHtmlFactory(page, { req });
  const content = page.render({ html, req });
  return new Response(content, {
    headers: { "content-type": "text/html; charset=utf8" },
  });
});
