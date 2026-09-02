# Avatar assets

Pictures a hive402 node and its agents can wear, and the scripts that draw them.

They live here, next to `site/`, because the eventual picker (spec Next Step)
serves them from the website: a person choosing a face should click one, not
find a URL and host an image.

| File | Who wears it |
|---|---|
| `node-hive.png` | The **node**. Three cells sharing walls, from `../hive-cells.svg`: a hive is several cells. |
| `agent-smiling.png` | An **agent**. One cell, two eyes, a smile. |
| `agent-cell.png` | An **agent**. One cell, two eyes, and the third cell left as a cell. |
| `agent-plain.png` | An **agent**. The original three-dot mark, no face. |

The node and an agent are deliberately different shapes. A member list renders
these at about 32px, where detail does not survive but "three shapes" versus
"one shape" still does, so the hierarchy reads even when the drawing does not.

## Why PNG, and why hand-drawn

`../avatar.svg` and `../hive-cells.svg` are the real marks. These are PNG
renderings of them because **whether a Buzz client draws an SVG avatar is
unverified**, and that is not a variable worth carrying into someone's member
list. PNG is drawn by everything.

`render-avatars.mjs` and `render-node.mjs` produce them with nothing but
`node:zlib` — a small PNG encoder and a polygon fill, supersampled 4x. No image
library, no build step, no dependency to keep alive for four files that change
about once a year.

```bash
node render-avatars.mjs   # agent-smiling.png, agent-cell.png
node render-node.mjs      # node-hive.png
```

## Putting one on

Upload it to your community first, then use the URL it returns. **Every picture
that works in a Buzz room is hosted by that community's own relay**, and members'
clients fetch it as members; an outside URL may not be fetched at all.

```bash
buzz upload file --file agent-smiling.png
```

For an agent, put the returned URL in its config entry as `"avatar": "<url>"`.
For the node, `hive402 profile --avatar <url>`.
