/**
 * The two names the MCP server and the in-chat story view must agree on.
 *
 * They are wire strings — the chat host quotes them back to us verbatim and
 * validates neither — so they live in ONE place both ends import rather than
 * being typed out twice. Disagreement here has no error message: the tool
 * nominates a view nobody serves, or the view waits for data under a key
 * nobody sent, and the panel is simply blank.
 *
 * Here, and not beside the renderer, because the API imports this at RUNTIME:
 * a compiled server can only require a package that ships JavaScript, and this
 * is the shared one that does.
 *
 */

/**
 * The view, addressed the way the MCP Apps extension addresses views. One
 * resource for every automation: the HTML is the renderer, and the story it
 * draws arrives with the tool result.
 */
export const STORY_APP_RESOURCE_URI = "ui://listen-fire/automation-story";

/**
 * Where the story rides on that result.
 *
 * `_meta` and not `structuredContent`: metadata is defined as host-and-view
 * business that never reaches the model, and a client that has never heard of
 * MCP Apps is required to ignore it — which is what makes this addition
 * invisible to every other client.
 */
export const STORY_RESULT_META_KEY = "dev.listen-fire/story";
