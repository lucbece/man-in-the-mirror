/**
 * Refuse state-changing requests that came from somebody else's page.
 *
 * The panel binds to 127.0.0.1 and has no login, which is right for a local
 * control panel and is *not* the same as being unreachable. Any page in any
 * tab can post to localhost, and the browser will do it — so "only you can
 * reach it" quietly means "anything you browse can reach it too".
 *
 * Verified before this existed: with the panel running, a form-encoded POST
 * carrying `Origin: https://evil.example` returned 200 and stopped the bot.
 *
 * The reachable set was small, and the reason is worth writing down because it
 * is what people usually assume protects them and mostly doesn't. Anything
 * taking a JSON body was already safe: `application/json` is not a *simple*
 * request, so the browser sends a preflight first, and nothing here answers
 * one. What was exposed is every route that needs no body at all —
 * `/api/bot/:action` reads only `req.params` — because an HTML form can send
 * one of those with no preflight to block.
 *
 * So the check is on the two headers browsers attach and pages cannot forge:
 *
 * - `Sec-Fetch-Site` says where the request came from relative to its target.
 *   Anything other than `same-origin` or `none` is somebody else's page.
 * - `Origin`, which browsers always send on a cross-origin POST.
 *
 * Absent headers are allowed through on purpose. curl and the launcher send
 * neither, and blocking them would break scripting to prevent an attack that
 * needs a browser to exist — the whole class of problem here is "a page the
 * user visited", and a page cannot suppress these headers.
 */

/** Methods that can change something. GET and HEAD are left alone. */
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Does this Origin name the same server the request arrived at? */
function isOwnOrigin(origin, host) {
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false; // not a URL at all, so not ours
  }
}

export function sameOriginOnly(req, res, next) {
  if (!UNSAFE.has(req.method)) return next();

  const site = req.get('sec-fetch-site');
  // `none` means the user did it themselves — typed the URL, used a bookmark.
  if (site && site !== 'same-origin' && site !== 'none') {
    return res.status(403).json({
      error: `Refused: this request came from ${site === 'cross-site' ? 'another site' : 'a different origin'}. The control panel only accepts changes from its own page.`,
    });
  }

  const origin = req.get('origin');
  if (origin && !isOwnOrigin(origin, req.get('host'))) {
    return res.status(403).json({
      error: 'Refused: that request came from another origin.',
    });
  }

  return next();
}
