// Pip in the playground: `npm start`, then open the printed link and pick a test person.

import { simulators } from "../../../simulators/src/index.ts";
import { buildAgent } from "./agent.ts";

const play = simulators({ title: "Pip · Bean & Leaf" });
const agent = buildAgent({ events: [play.events] });
const { url } = await play.listen(agent, Number(process.env.PORT ?? 8788));
console.log(`Pip's playground: ${url}/`);
console.log(`Every channel side by side: ${url}/person`);
