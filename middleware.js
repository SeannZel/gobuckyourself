// Vercel Edge Middleware — gates the whole site behind an access code.
// Set ACCESS_CODE in Vercel → Project → Settings → Environment Variables. If it is unset, the gate is disabled.
export const config = { matcher: ['/((?!favicon.ico).*)'] };

const COOKIE = 'gby_access';
const OPEN_PATHS = new Set(['/gate', '/gate.html', '/api/gate']);
const OPEN_PREFIXES = ['/css/', '/js/app.js']; // needed to render the gate page itself

async function token(code) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('gby:' + code));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function cookieValue(req, name) {
  const m = (req.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

export default async function middleware(req) {
  const code = process.env.ACCESS_CODE;
  if (!code) return; // gate disabled

  const url = new URL(req.url);
  const path = url.pathname;
  const expected = await token(code);

  // Login submission
  if (path === '/api/gate' && req.method === 'POST') {
    const form = await req.formData().catch(() => null);
    const attempt = (form?.get('code') || '').toString().trim();
    const next = (form?.get('next') || '/').toString();
    const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';
    if (attempt && attempt === code) {
      return new Response(null, {
        status: 303,
        headers: {
          Location: safeNext,
          'Set-Cookie': `${COOKIE}=${expected}; Path=/; Max-Age=${60 * 60 * 24 * 90}; HttpOnly; Secure; SameSite=Lax`,
        },
      });
    }
    return Response.redirect(new URL(`/gate?error=1&next=${encodeURIComponent(safeNext)}`, req.url), 303);
  }

  if (path === '/api/gate/logout') {
    return new Response(null, { status: 303, headers: { Location: '/gate', 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` } });
  }

  const authed = cookieValue(req, COOKIE) === expected;
  if (OPEN_PATHS.has(path) || OPEN_PREFIXES.some(p => path.startsWith(p))) {
    if (authed && (path === '/gate' || path === '/gate.html')) return Response.redirect(new URL('/', req.url), 302);
    return;
  }
  if (authed) return;
  return Response.redirect(new URL(`/gate?next=${encodeURIComponent(path + url.search)}`, req.url), 302);
}
