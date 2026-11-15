import { esc } from "./presentation";

type Markup = {html:string};

export const markup = (html: string): Markup => ({ html });

export function element(tag: string, attributes: Record<string, string | number | boolean | null>, ...children: (string | number | Markup)[]): string{
    const attrs = Object.entries(attributes).filter(([, value]) => value !== false && value !== null)
        .map(([name, value]) => value === true ? ` ${name}` : ` ${name}="${esc(String(value))}"`).join("");
    const body = children.map((child) => typeof child === "object" ? child.html : esc(String(child))).join("");
    return `<${tag}${attrs}>${body}</${tag}>`;
}

export const html = (strings: TemplateStringsArray, ...values: unknown[]): string => strings.reduce((result, part, i) => result + String(values[i - 1]) + part);
