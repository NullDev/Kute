import { element, markup } from "../element";
import type { Terminal } from "../terminal";

export function introView(_desk: Terminal, title: string, subtitle: string, actions = ""): string{
    const heading = element("h1", {}, title);
    const description = element("p", { "class": "sub" }, subtitle);
    return element("div", { "class": "pageIntro" }, markup(element("div", {}, markup(heading + description))), markup(actions));
}
