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

interface Renderable {
  render: (ctx: RenderContext) => string | SafeHtml;
}

interface RenderContext {
  html: Html;
  req: Request;
}

type Html = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => string | SafeHtml;

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
  isAsync: boolean;
  promiseSource: string | null;
  thenCallback: string | null;
  catchCallback: string | null;
}

interface AsyncBinding {
  id: string;
  promiseSource: string;
  thenCallback: string;
  catchCallback: string | null;
}

function analyzeAsyncExpression(expr: any): {
  isAsync: boolean;
  promiseSource: string | null;
  thenCallback: string | null;
  catchCallback: string | null;
} {
  let current = expr;
  let thenCallback: string | null = null;
  let catchCallback: string | null = null;
  let promiseSource: string | null = null;

  // Check for .catch() at the end
  if (
    current.type === "CallExpression" &&
    current.callee?.type === "MemberExpression" &&
    current.callee.property?.name === "catch"
  ) {
    catchCallback = generate(current.arguments[0]).code;
    current = current.callee.object;
  }

  // Check for .then()
  if (
    current.type === "CallExpression" &&
    current.callee?.type === "MemberExpression" &&
    current.callee.property?.name === "then"
  ) {
    thenCallback = generate(current.arguments[0]).code;
    current = current.callee.object;
    promiseSource = generate(current).code;
  }

  return {
    isAsync: thenCallback !== null,
    promiseSource,
    thenCallback,
    catchCallback,
  };
}

type RenderFn = (ctx: RenderContext) => string | SafeHtml;

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

        // Check for async patterns
        const asyncInfo = analyzeAsyncExpression(expr);

        // Walk for this.x references (skip if async - we handle that separately)
        if (!asyncInfo.isAsync) {
          traverse(
            ast,
            {
              MemberExpression(innerPath: any) {
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
        }

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
          isAsync: asyncInfo.isAsync,
          promiseSource: asyncInfo.promiseSource,
          thenCallback: asyncInfo.thenCallback,
          catchCallback: asyncInfo.catchCallback,
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
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
  attribute?: string;
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
  asyncBindings: AsyncBinding[] = [],
): string {
  const allSignals = new Set<string>();
  bindings.forEach((b) => b.signals.forEach((s) => allSignals.add(s)));
  handlers.forEach((h) => h.writes.forEach((s) => allSignals.add(s)));

  let script = "\n<script>\n(function() {\n";

  // Declare signals
  for (const signal of allSignals) {
    // deno-lint-ignore no-explicit-any
    script += `  let ${signal} = ${
      JSON.stringify((instance as any)[signal])
    };\n`;
  }

  // Element refs
  const allIds = [
    ...new Set([
      ...bindings.map((b) => b.id),
      ...handlers.map((h) => h.id),
      ...asyncBindings.map((a) => a.id),
    ]),
  ];
  for (const id of allIds) {
    script += `  const ${id} = document.querySelector('[${ATTR}="${id}"]');\n`;
  }

  // Update function
  script += `  function __update() {\n`;
  for (const b of bindings) {
    const expr = b.source.replace(/this\./g, "");
    if (b.attribute) {
      script += `    ${b.id}.setAttribute("${b.attribute}", ${expr});\n`;
    } else {
      script += `    ${b.id}.textContent = ${expr};\n`;
    }
  }
  script += `  }\n`;

  // Event handlers
  for (const h of handlers) {
    const body = h.source.replace(/this\./g, "");
    script += `  ${h.id}.${h.event} = () => { ${body}; __update(); };\n`;
  }

  // Async bindings
  for (const a of asyncBindings) {
    const promise = a.promiseSource.replace(/this\./g, "");
    const thenCb = a.thenCallback.replace(/this\./g, "");

    script += `  ${promise}\n`;
    script += `    .then(${thenCb})\n`;
    script +=
      `    .then(__html => { ${a.id}.innerHTML = typeof __html === 'object' ? __html.content : __html; })`;

    if (a.catchCallback) {
      const catchCb = a.catchCallback.replace(/this\./g, "");
      script += `\n    .catch(${catchCb})`;
      script +=
        `\n    .then(__html => { if (__html) ${a.id}.innerHTML = typeof __html === 'object' ? __html.content : __html; })`;
    }

    script += `;\n`;
  }

  script += "})();\n</script>";

  return script;
}
// At the top of the file
const HTML_MARKER = Symbol("safeHtml");

export interface SafeHtml {
  [HTML_MARKER]: true;
  content: string;
  toString(): string;
}

function safeHtml(content: string): SafeHtml {
  return {
    [HTML_MARKER]: true,
    content,
    toString() {
      return content;
    },
  };
}

export function isSafeHtml(value: unknown): value is SafeHtml {
  return typeof value === "object" && value !== null && HTML_MARKER in value;
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
  const asyncBindings: AsyncBinding[] = [];
  const elementIds: Map<unknown, string> = new Map();

  // deno-lint-ignore no-explicit-any
  const { document } = parseHTML(
    "<!DOCTYPE html><html><body></body></html>",
  ) as any;

  const html: Html = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const writtenSignals = new Set<string>();
    analysis.forEach((expr) => {
      if (expr?.writes) {
        expr.writes.forEach((w) => writtenSignals.add(w));
      }
    });

    let templateHtml = "";
    const placeholders: Map<string, { value: unknown; expr: ExprAnalysis }> =
      new Map();

    for (let i = 0; i < strings.length; i++) {
      templateHtml += strings[i];

      if (i < values.length) {
        const value = values[i];
        const expr = analysis[i];

        const attrMatch = strings[i].match(/(\w+)=(['"]?)$/);
        const isAttrPosition = attrMatch && !attrMatch[2];

        const isEvent = expr?.isEvent;
        const isReactive = expr?.signals?.some((s) => writtenSignals.has(s));
        const isAsync = expr?.isAsync;

        if (isAsync) {
          // Async expression - render placeholder, add to asyncBindings
          const id = `_${idCounter.value++}`;
          templateHtml += `<span ${ATTR}="${id}"></span>`;
          asyncBindings.push({
            id,
            promiseSource: expr.promiseSource!,
            thenCallback: expr.thenCallback!,
            catchCallback: expr.catchCallback,
          });
        } else if (isEvent || isReactive) {
          const placeholder = `__PLACEHOLDER_${i}__`;
          placeholders.set(placeholder, { value, expr });
          if (isAttrPosition) {
            templateHtml += `"${placeholder}"`;
          } else {
            templateHtml += placeholder;
          }
        } else if (isSafeHtml(value)) {
          templateHtml += value.content;
        } else if (isRenderable(value)) {
          const childHtml = createHtmlFactory(value, ctx, idCounter);
          const rendered = value.render({ html: childHtml, ...ctx });
          templateHtml += isSafeHtml(rendered) ? rendered.content : rendered;
        } else if (Array.isArray(value)) {
          for (const item of value) {
            if (isSafeHtml(item)) {
              templateHtml += item.content;
            } else if (isRenderable(item)) {
              const childHtml = createHtmlFactory(item, ctx, idCounter);
              const rendered = item.render({ html: childHtml, ...ctx });
              templateHtml += isSafeHtml(rendered)
                ? rendered.content
                : rendered;
            } else if (item === false || item === null || item === undefined) {
              // Skip
            } else {
              const temp = document.createElement("div");
              temp.textContent = String(item);
              templateHtml += temp.innerHTML;
            }
          }
        } else if (value === false || value === null || value === undefined) {
          if (isAttrPosition) {
            templateHtml = templateHtml.replace(/\s\w+=$/, "");
          }
        } else {
          if (isAttrPosition) {
            const temp = document.createElement("div");
            temp.textContent = String(value);
            templateHtml += `"${temp.innerHTML}"`;
          } else {
            const temp = document.createElement("div");
            temp.textContent = String(value);
            templateHtml += temp.innerHTML;
          }
        }
      }
    }

    // If no placeholders and no async, we're done
    if (
      placeholders.size === 0 && asyncBindings.length === 0 &&
      handlers.length === 0
    ) {
      return safeHtml(templateHtml);
    }

    // Parse and process placeholders
    const root = document.createElement("div");
    root.innerHTML = templateHtml;

    // 1. Process event attributes
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

    // 2. Process non-event attribute placeholders
    for (const el of allElements) {
      for (const attr of [...el.attributes]) {
        for (const [placeholder, { value, expr }] of placeholders) {
          if (attr.value === placeholder && !expr?.isEvent) {
            const isReactive = expr?.signals?.some((s: string) =>
              writtenSignals.has(s)
            );

            if (isReactive) {
              let id = elementIds.get(el);
              if (!id) {
                id = `_${idCounter.value++}`;
                el.setAttribute(ATTR, id);
                elementIds.set(el, id);
              }

              el.setAttribute(attr.name, String(value));

              bindings.push({
                id,
                signals: expr.signals,
                source: expr.source,
                attribute: attr.name,
              });
            } else {
              el.setAttribute(attr.name, String(value));
            }
          }
        }
      }
    }

    // 3. Process text node placeholders
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
        if (expr?.isEvent) continue;

        const isReactive = expr?.signals?.some((s: string) =>
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
        }
      }
    }

    let result = root.innerHTML;

    if (
      handlers.length > 0 || bindings.length > 0 || asyncBindings.length > 0
    ) {
      result += generateScript(page, bindings, handlers, asyncBindings);
    }

    return safeHtml(result);
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

class Await<T> {
  state: unknown;
  constructor(
    props: {
      promise: Promise<T>;
      loading?: string | SafeHtml;
      then: (res: T) => string | SafeHtml;
      catch?: (err: Error) => string | SafeHtml;
    },
  ) {
    this.state = props.loading ?? ``;
    props.promise.then(props.then).catch(props?.catch);
  }

  render() {
    return this.state;
  }
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
        ${new List()}
        ${new Counter({ initial: 5 })}
        ${new Counter({ initial: 22 })}
      </body>
    </html>`;
  }
}

class List {
  async getTodos() {
    return await fetch("https://jsonplaceholder.typicode.com/todos").then(
      (res) => res.json() as unknown as [{ userId: number }],
    );
  }

  render({ html }: RenderContext) {
    return html`<div>${new Await({
      promise: this.getTodos(),
      loading: html`<span>loading</span>`,
      then: (todos) =>
        html`<ul>${todos.map((todo) => html`<li>${todo}</li>`)}</ul>`,
    })}`;
  }
}

class Counter {
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
  // In your server handler or wherever you call render:
  const result = page.render({ html, req });
  const content = isSafeHtml(result) ? result.content : result;
  return new Response(content, {
    headers: { "content-type": "text/html; charset=utf8" },
  });
});
