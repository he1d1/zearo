import { assertEquals } from "@std/assert";
import {
  analyzeRender,
  createHtmlFactory,
  generateScript,
  isSafeHtml,
  SafeHtml,
} from "./main.ts";

// Helper to get string content from render result
function getContent(result: string | SafeHtml): string {
  return isSafeHtml(result) ? result.content : result;
}

Deno.test("analyzeRender - detects signal reads", () => {
  class Counter {
    count = 0;
    render({ html }: any) {
      return html`<span>${this.count}</span>`;
    }
  }

  const analysis = analyzeRender(Counter.prototype.render);

  assertEquals(analysis.length, 1);
  assertEquals(analysis[0].signals, ["count"]);
  assertEquals(analysis[0].isEvent, false);
  assertEquals(analysis[0].isFunction, false);
});

Deno.test("analyzeRender - detects event handlers", () => {
  class Counter {
    count = 0;
    render({ html }: any) {
      return html`<button onclick=${() => this.count++}>click</button>`;
    }
  }

  const analysis = analyzeRender(Counter.prototype.render);

  assertEquals(analysis.length, 1);
  assertEquals(analysis[0].isEvent, true);
  assertEquals(analysis[0].isFunction, true);
  assertEquals(analysis[0].eventName, "onclick");
  assertEquals(analysis[0].writes, ["count"]);
});

Deno.test("analyzeRender - detects multiple signals in one expression", () => {
  class Adder {
    a = 1;
    b = 2;
    render({ html }: any) {
      return html`<span>${this.a + this.b}</span>`;
    }
  }

  const analysis = analyzeRender(Adder.prototype.render);

  assertEquals(analysis.length, 1);
  assertEquals(analysis[0].signals.sort(), ["a", "b"]);
});

Deno.test("analyzeRender - mixed static and reactive", () => {
  class Mixed {
    count = 0;
    render({ html }: any) {
      return html`<div>${"static"}${this.count}</div>`;
    }
  }

  const analysis = analyzeRender(Mixed.prototype.render);

  assertEquals(analysis.length, 2);
  assertEquals(analysis[0].signals, []);
  assertEquals(analysis[1].signals, ["count"]);
});

Deno.test("generateScript - creates correct variable declarations", () => {
  const instance = { count: 5, render: () => "" };
  const bindings = [{ id: "_0", signals: ["count"], source: "this.count" }];
  const handlers: any[] = [];

  const script = generateScript(instance, bindings, handlers);

  assertEquals(script.includes("let count = 5;"), true);
});

Deno.test("generateScript - creates correct element selectors", () => {
  const instance = { count: 0, render: () => "" };
  const bindings = [{ id: "_0", signals: ["count"], source: "this.count" }];
  const handlers: any[] = [];

  const script = generateScript(instance, bindings, handlers);

  assertEquals(
    script.includes("document.querySelector('[data-zid=\"_0\"]')"),
    true,
  );
});

Deno.test("generateScript - creates update function", () => {
  const instance = { count: 0, render: () => "" };
  const bindings = [{ id: "_0", signals: ["count"], source: "this.count" }];
  const handlers: any[] = [];

  const script = generateScript(instance, bindings, handlers);

  assertEquals(script.includes("function __update()"), true);
  assertEquals(script.includes("_0.textContent = count"), true);
});

Deno.test("generateScript - creates event handlers", () => {
  const instance = { count: 0, render: () => "" };
  const bindings: any[] = [];
  const handlers = [{
    id: "_0",
    event: "onclick",
    source: "count++",
    writes: ["count"],
  }];

  const script = generateScript(instance, bindings, handlers);

  assertEquals(
    script.includes("_0.onclick = () => { count++; __update(); }"),
    true,
  );
});

Deno.test("createHtmlFactory - renders static content", () => {
  class Static {
    render({ html }: any) {
      return html`<div>hello</div>`;
    }
  }

  const instance = new Static();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  assertEquals(result.includes("<div>hello</div>"), true);
});

Deno.test("createHtmlFactory - renders reactive content with data-zid", () => {
  class Counter {
    count = 5;
    render({ html }: any) {
      return html`<button onclick=${() => this.count++}>${this.count}</button>`;
    }
  }

  const instance = new Counter();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  assertEquals(result.includes("data-zid="), true);
  assertEquals(result.includes(">5<"), true);
});

Deno.test("createHtmlFactory - renders event handlers", () => {
  class Counter {
    count = 0;
    render({ html }: any) {
      return html`<button onclick=${() => this.count++}>click</button>`;
    }
  }

  const instance = new Counter();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  assertEquals(result.includes("data-zid="), true);
  assertEquals(result.includes("<script>"), true);
  assertEquals(result.includes("onclick"), true);
});

Deno.test("createHtmlFactory - child components render", () => {
  class Child {
    render({ html }: any) {
      return html`<span>child</span>`;
    }
  }

  class Parent {
    render({ html }: any) {
      return html`<div>${new Child()}</div>`;
    }
  }

  const instance = new Parent();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  assertEquals(result.includes("<span>child</span>"), true);
});

Deno.test("analyzeRender - nested property access", () => {
  class List {
    items = [1, 2, 3];
    render({ html }: any) {
      return html`<span>${this.items.length}</span>`;
    }
  }

  const analysis = analyzeRender(List.prototype.render);

  assertEquals(analysis.length, 1);
  assertEquals(analysis[0].signals, ["items"]);
});

Deno.test("analyzeRender - multiple events on same element", () => {
  class Interactive {
    count = 0;
    render({ html }: any) {
      return html`<button onclick=${() => this.count++} onmouseenter=${() =>
        this.count--}>click</button>`;
    }
  }

  const analysis = analyzeRender(Interactive.prototype.render);

  assertEquals(analysis.length, 2);
  assertEquals(analysis[0].isEvent, true);
  assertEquals(analysis[0].eventName, "onclick");
  assertEquals(analysis[1].isEvent, true);
  assertEquals(analysis[1].eventName, "onmouseenter");
});

Deno.test("analyzeRender - assignment expression", () => {
  class Setter {
    value = "";
    render({ html }: any) {
      return html`<input oninput=${() => this.value = "test"}>`;
    }
  }

  const analysis = analyzeRender(Setter.prototype.render);

  assertEquals(analysis.length, 1);
  assertEquals(analysis[0].writes, ["value"]);
});

Deno.test("analyzeRender - decrement operator", () => {
  class Counter {
    count = 10;
    render({ html }: any) {
      return html`<button onclick=${() => this.count--}>-</button>`;
    }
  }

  const analysis = analyzeRender(Counter.prototype.render);

  assertEquals(analysis[0].writes, ["count"]);
});

Deno.test("createHtmlFactory - child component with props", () => {
  class Counter {
    count: number;
    constructor({ initial = 0 } = {}) {
      this.count = initial;
    }
    render({ html }: any) {
      return html`<span>${this.count}</span>`;
    }
  }

  class Parent {
    render({ html }: any) {
      return html`<div>${new Counter({ initial: 42 })}</div>`;
    }
  }

  const instance = new Parent();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  assertEquals(result.includes(">42<"), true);
});

Deno.test("createHtmlFactory - multiple children", () => {
  class Item {
    name: string;
    constructor({ name = "" } = {}) {
      this.name = name;
    }
    render({ html }: any) {
      return html`<li>${this.name}</li>`;
    }
  }

  class List {
    render({ html }: any) {
      return html`<ul>${new Item({ name: "a" })}${new Item({
        name: "b",
      })}</ul>`;
    }
  }

  const instance = new List();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  assertEquals(result.includes("<li>a</li>"), true);
  assertEquals(result.includes("<li>b</li>"), true);
});

Deno.test("createHtmlFactory - deeply nested components", () => {
  class Inner {
    render({ html }: any) {
      return html`<span>inner</span>`;
    }
  }

  class Middle {
    render({ html }: any) {
      return html`<div>${new Inner()}</div>`;
    }
  }

  class Outer {
    render({ html }: any) {
      return html`<section>${new Middle()}</section>`;
    }
  }

  const instance = new Outer();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  assertEquals(
    result.includes("<section><div><span>inner</span></div></section>"),
    true,
  );
});

Deno.test("createHtmlFactory - mixed static and reactive children", () => {
  class Counter {
    count = 5;
    render({ html }: any) {
      return html`<span>${this.count}</span>`;
    }
  }

  class Parent {
    render({ html }: any) {
      return html`<div>${"static text"}${new Counter()}</div>`;
    }
  }

  const instance = new Parent();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  assertEquals(result.includes("static text"), true);
  assertEquals(result.includes(">5<"), true);
});

Deno.test("createHtmlFactory - sibling reactive elements", () => {
  class Multi {
    a = 1;
    b = 2;
    render({ html }: any) {
      return html`<div>
        <button onclick=${() => this.a++}>${this.a}</button>
        <button onclick=${() => this.b++}>${this.b}</button>
      </div>`;
    }
  }

  const instance = new Multi();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  assertEquals(result.includes(">1<"), true);
  assertEquals(result.includes(">2<"), true);

  const htmlOnly = result.split("<script>")[0];
  assertEquals((htmlOnly.match(/data-zid/g) || []).length, 2);
});

Deno.test("createHtmlFactory - no script tag for static content", () => {
  class Static {
    render({ html }: any) {
      return html`<div>just static</div>`;
    }
  }

  const instance = new Static();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  assertEquals(result.includes("<script>"), false);
});

Deno.test("createHtmlFactory - handles null/undefined values", () => {
  class Nullable {
    render({ html }: any) {
      return html`<div>${null}${undefined}</div>`;
    }
  }

  const instance = new Nullable();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  assertEquals(result.includes("<div>"), true);
});

Deno.test("createHtmlFactory - handles number values", () => {
  class Numbers {
    render({ html }: any) {
      return html`<div>${42}${3.14}</div>`;
    }
  }

  const instance = new Numbers();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  assertEquals(result.includes("42"), true);
  assertEquals(result.includes("3.14"), true);
});

Deno.test("createHtmlFactory - handles boolean values", () => {
  class Booleans {
    render({ html }: any) {
      return html`<div>${true}${false}</div>`;
    }
  }

  const instance = new Booleans();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  assertEquals(result.includes("true"), true);
  assertEquals(result.includes("false"), false);
});

Deno.test("generateScript - multiple signals in update function", () => {
  const instance = { a: 1, b: 2, render: () => "" };
  const bindings = [
    { id: "_0", signals: ["a"], source: "this.a" },
    { id: "_1", signals: ["b"], source: "this.b" },
  ];
  const handlers: any[] = [];

  const script = generateScript(instance, bindings, handlers);

  assertEquals(script.includes("let a = 1;"), true);
  assertEquals(script.includes("let b = 2;"), true);
  assertEquals(script.includes("_0.textContent = a"), true);
  assertEquals(script.includes("_1.textContent = b"), true);
});

Deno.test("generateScript - handler modifies multiple signals", () => {
  const instance = { x: 0, y: 0, render: () => "" };
  const bindings: any[] = [];
  const handlers = [{
    id: "_0",
    event: "onclick",
    source: "x++; y++",
    writes: ["x", "y"],
  }];

  const script = generateScript(instance, bindings, handlers);

  assertEquals(script.includes("let x = 0;"), true);
  assertEquals(script.includes("let y = 0;"), true);
});

Deno.test("createHtmlFactory - same element with event and reactive text", () => {
  class Button {
    count = 0;
    render({ html }: any) {
      return html`<button onclick=${() => this.count++}>${this.count}</button>`;
    }
  }

  const instance = new Button();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  const htmlOnly = result.split("<script>")[0];
  assertEquals((htmlOnly.match(/data-zid/g) || []).length, 1);
});

Deno.test("analyzeRender - compound assignment", () => {
  class Counter {
    count = 0;
    render({ html }: any) {
      return html`<button onclick=${() => this.count += 5}>+5</button>`;
    }
  }

  const analysis = analyzeRender(Counter.prototype.render);

  assertEquals(analysis[0].writes, ["count"]);
});

Deno.test("createHtmlFactory - array map rendering", () => {
  class List {
    items = ["a", "b", "c"];
    render({ html }: any) {
      return html`<ul>${this.items.map((i) => html`<li>${i}</li>`)}</ul>`;
    }
  }

  const instance = new List();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  assertEquals(result.includes("<li>a</li>"), true);
  assertEquals(result.includes("<li>b</li>"), true);
  assertEquals(result.includes("<li>c</li>"), true);
});

Deno.test("createHtmlFactory - conditional rendering with && (true)", () => {
  class Conditional {
    show = true;
    render({ html }: any) {
      return html`<div>${this.show && html`<span>visible</span>`}</div>`;
    }
  }

  const instance = new Conditional();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  assertEquals(result.includes("<span>visible</span>"), true);
});

Deno.test("createHtmlFactory - conditional rendering with && (false)", () => {
  class Conditional {
    show = false;
    render({ html }: any) {
      return html`<div>${this.show && html`<span>visible</span>`}</div>`;
    }
  }

  const instance = new Conditional();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  assertEquals(result.includes("<span>visible</span>"), false);
  assertEquals(result.includes("false"), false);
});

Deno.test("createHtmlFactory - conditional rendering with ternary", () => {
  class Conditional {
    loggedIn = true;
    render({ html }: any) {
      return html`<div>${
        this.loggedIn ? html`<span>Welcome</span>` : html`<span>Login</span>`
      }</div>`;
    }
  }

  const instance = new Conditional();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  assertEquals(result.includes("Welcome"), true);
  assertEquals(result.includes("Login"), false);
});

Deno.test("createHtmlFactory - conditional rendering with ternary (else branch)", () => {
  class Conditional {
    loggedIn = false;
    render({ html }: any) {
      return html`<div>${
        this.loggedIn ? html`<span>Welcome</span>` : html`<span>Login</span>`
      }</div>`;
    }
  }

  const instance = new Conditional();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  assertEquals(result.includes("Welcome"), false);
  assertEquals(result.includes("Login"), true);
});

Deno.test("createHtmlFactory - conditional with component", () => {
  class Modal {
    render({ html }: any) {
      return html`<div class="modal">Modal content</div>`;
    }
  }

  class Page {
    showModal = true;
    render({ html }: any) {
      return html`<div>${this.showModal && new Modal()}</div>`;
    }
  }

  const instance = new Page();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  assertEquals(result.includes("Modal content"), true);
});

Deno.test("createHtmlFactory - conditional with component (hidden)", () => {
  class Modal {
    render({ html }: any) {
      return html`<div class="modal">Modal content</div>`;
    }
  }

  class Page {
    showModal = false;
    render({ html }: any) {
      return html`<div>${this.showModal && new Modal()}</div>`;
    }
  }

  const instance = new Page();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  assertEquals(result.includes("Modal content"), false);
});

Deno.test("createHtmlFactory - reactive conditional toggle", () => {
  class Toggle {
    visible = true;
    render({ html }: any) {
      return html`<div>
        <button onclick=${() => this.visible = !this.visible}>Toggle</button>
        ${this.visible && html`<span>Content</span>`}
      </div>`;
    }
  }

  const instance = new Toggle();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  assertEquals(result.includes("<span>Content</span>"), true);
  assertEquals(result.includes("onclick"), true);
});

Deno.test("createHtmlFactory - null/undefined conditionals", () => {
  class Maybe {
    name: string | null = null;
    render({ html }: any) {
      return html`<div>${this.name ?? "Anonymous"}</div>`;
    }
  }

  const instance = new Maybe();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  assertEquals(result.includes("Anonymous"), true);
});

Deno.test("createHtmlFactory - null/undefined conditionals with value", () => {
  class Maybe {
    name: string | null = "Claude";
    render({ html }: any) {
      return html`<div>${this.name ?? "Anonymous"}</div>`;
    }
  }

  const instance = new Maybe();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  assertEquals(result.includes("Claude"), true);
  assertEquals(result.includes("Anonymous"), false);
});

Deno.test("createHtmlFactory - static class attribute", () => {
  class Styled {
    render({ html }: any) {
      return html`<div class=${"container"}>content</div>`;
    }
  }

  const instance = new Styled();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  assertEquals(result.includes('class="container"'), true);
});

Deno.test("createHtmlFactory - dynamic class attribute", () => {
  class Toggle {
    active = true;
    render({ html }: any) {
      return html`<div class=${this.active ? "on" : "off"}>content</div>`;
    }
  }

  const instance = new Toggle();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  assertEquals(result.includes('class="on"'), true);
});

Deno.test("createHtmlFactory - reactive class attribute", () => {
  class Toggle {
    active = true;
    render({ html }: any) {
      return html`<button onclick=${() => this.active = !this.active} class=${
        this.active ? "on" : "off"
      }>toggle</button>`;
    }
  }

  const instance = new Toggle();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  assertEquals(result.includes('class="on"'), true);
  assertEquals(result.includes("<script>"), true);
});

Deno.test("createHtmlFactory - boolean attribute true", () => {
  class Input {
    render({ html }: any) {
      return html`<input disabled=${true}>`;
    }
  }

  const instance = new Input();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  assertEquals(result.includes("disabled"), true);
});

Deno.test("createHtmlFactory - boolean attribute false", () => {
  class Input {
    render({ html }: any) {
      return html`<input disabled=${false}>`;
    }
  }

  const instance = new Input();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  assertEquals(result.includes("disabled"), false);
});

Deno.test("createHtmlFactory - href attribute", () => {
  class Link {
    url = "https://example.com";
    render({ html }: any) {
      return html`<a href=${this.url}>link</a>`;
    }
  }

  const instance = new Link();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  assertEquals(result.includes('href="https://example.com"'), true);
});

Deno.test("createHtmlFactory - multiple attributes", () => {
  class Element {
    render({ html }: any) {
      return html`<div id=${"myId"} class=${"myClass"} data-value=${"123"}>content</div>`;
    }
  }

  const instance = new Element();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  assertEquals(result.includes('id="myId"'), true);
  assertEquals(result.includes('class="myClass"'), true);
  assertEquals(result.includes('data-value="123"'), true);
});

Deno.test("createHtmlFactory - multiple events on same element", () => {
  class Interactive {
    count = 0;
    hovered = false;
    render({ html }: any) {
      return html`<button 
        onclick=${() => this.count++} 
        onmouseenter=${() => this.hovered = true}
      >hover me</button>`;
    }
  }

  const instance = new Interactive();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  const htmlOnly = result.split("<script>")[0];
  assertEquals((htmlOnly.match(/data-zid/g) || []).length, 1);

  assertEquals(result.includes(".onclick"), true);
  assertEquals(result.includes(".onmouseenter"), true);
});

Deno.test("createHtmlFactory - request context", () => {
  class Page {
    render({ html, req }: any) {
      return html`<div>${req.url}</div>`;
    }
  }

  const instance = new Page();
  const ctx = { req: new Request("http://localhost/test") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  assertEquals(result.includes("http://localhost/test"), true);
});

Deno.test("createHtmlFactory - empty template", () => {
  class Empty {
    render({ html }: any) {
      return html``;
    }
  }

  const instance = new Empty();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  assertEquals(result, "");
});

Deno.test("createHtmlFactory - self-closing tags", () => {
  class Form {
    value = "";
    render({ html }: any) {
      return html`<input type="text" value=${this.value} />`;
    }
  }

  const instance = new Form();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  assertEquals(result.includes('type="text"'), true);
  assertEquals(result.includes('value=""'), true);
});

Deno.test("createHtmlFactory - special characters escaped in text", () => {
  class Escaped {
    render({ html }: any) {
      return html`<div>${"<script>alert('xss')</script>"}</div>`;
    }
  }

  const instance = new Escaped();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  assertEquals(result.includes("<script>alert"), false);
  assertEquals(result.includes("&lt;script&gt;"), true);
});

Deno.test("createHtmlFactory - style object", () => {
  class Styled {
    render({ html }: any) {
      const styles = { color: "red", fontSize: "16px" };
      const styleStr = Object.entries(styles)
        .map(([k, v]) =>
          `${k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}: ${v}`
        )
        .join("; ");
      return html`<div style=${styleStr}>styled</div>`;
    }
  }

  const instance = new Styled();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  assertEquals(result.includes('style="color: red; font-size: 16px"'), true);
});

Deno.test("analyzeRender - detects async .then() pattern", () => {
  class Async {
    getData() {
      return Promise.resolve([1, 2, 3]);
    }
    render({ html }: any) {
      return html`<div>${
        this.getData().then((d) => html`<span>${d}</span>`)
      }</div>`;
    }
  }

  const analysis = analyzeRender(Async.prototype.render);

  assertEquals(analysis.length, 1);
  assertEquals(analysis[0].isAsync, true);
  assertEquals(analysis[0].promiseSource?.includes("getData"), true);
  assertEquals(analysis[0].thenCallback !== null, true);
});

Deno.test("analyzeRender - detects async .then().catch() pattern", () => {
  class Async {
    getData() {
      return Promise.resolve([1, 2, 3]);
    }
    render({ html }: any) {
      return html`<div>${
        this.getData()
          .then((d) => html`<span>${d}</span>`)
          .catch((e) => html`<span>Error</span>`)
      }</div>`;
    }
  }

  const analysis = analyzeRender(Async.prototype.render);

  assertEquals(analysis.length, 1);
  assertEquals(analysis[0].isAsync, true);
  assertEquals(analysis[0].catchCallback !== null, true);
});

Deno.test("createHtmlFactory - async renders placeholder", () => {
  class Async {
    getData() {
      return Promise.resolve("data");
    }
    render({ html }: any) {
      return html`<div>${
        this.getData().then((d) => html`<span>${d}</span>`)
      }</div>`;
    }
  }

  const instance = new Async();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  // Should have a placeholder element
  assertEquals(result.includes("data-zid="), true);
  // Should have script
  assertEquals(result.includes("<script>"), true);
  // Should have .then in script
  assertEquals(result.includes(".then"), true);
});

Deno.test("createHtmlFactory - async with catch renders placeholder", () => {
  class Async {
    getData() {
      return Promise.resolve("data");
    }
    render({ html }: any) {
      return html`<div>${
        this.getData()
          .then((d) => html`<span>${d}</span>`)
          .catch((e) => html`<span>Error</span>`)
      }</div>`;
    }
  }

  const instance = new Async();
  const ctx = { req: new Request("http://localhost/") };
  const html = createHtmlFactory(instance, ctx);
  const result = getContent(instance.render({ html, ...ctx }));

  assertEquals(result.includes(".catch"), true);
});

Deno.test("DEBUG - async detection", () => {
  class Async {
    getTodos() {
      return fetch("/api/todos").then((r) => r.json());
    }
    render({ html }: any) {
      return html`<div>${
        this.getTodos()
          .then((todos) => html`<ul>${todos}</ul>`)
          .catch((err) => html`<span>Error</span>`)
      }</div>`;
    }
  }

  const analysis = analyzeRender(Async.prototype.render);
  console.log("ANALYSIS:", JSON.stringify(analysis, null, 2));
});
