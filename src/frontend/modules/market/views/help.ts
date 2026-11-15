import template from "../../../components/marketHelp.html";
import { introView } from "./intro";
import type { Terminal, View } from "../terminal";

export function helpView(desk: Terminal): View{
    return {
        html:
            introView(desk, "How it works.", "Where every number comes from.") +
            template,
    };
}
