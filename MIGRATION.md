# Moving simpsons.chat from HostGator to Cloudflare

One Worker (`simpsons-chatbot`) now serves the site (`public/`) and the API (`/api/*`) from the same domain.

## 1. Deploy and test on workers.dev (HostGator stays live)

    cd simpsons-backend
    npx wrangler deploy

Open https://simpsons-chatbot.erccrr.workers.dev and test chat, thumbs, Undo, Contact, and /admin.html.

## 2. Move DNS to Cloudflare

1. Cloudflare dashboard -> Add a domain -> simpsons.chat (Free plan).
2. Copy any records you need to keep (especially MX/TXT if you use email on this domain). Delete the old A/CNAME records that point at HostGator.
3. At your registrar, replace the nameservers with the two Cloudflare gives you. Wait until Cloudflare shows the domain as Active.

## 3. Attach the domain

In `simpsons-backend/wrangler.toml`, uncomment the `routes = [...]` block, then:

    npx wrangler deploy

## 4. Verify, then retire HostGator

    curl -sI https://simpsons.chat | grep -i content-security-policy

Embedding test: an iframe of the site works from eric-carr.com and is blocked elsewhere. After a few days, cancel HostGator hosting (keep the registration if the domain is registered there; transferring it is optional).

## Notes
- `public/_headers` replaces the old `.htaccess` (delete `.htaccess` after cutover).
- The Analytics beacon in `index.html` is unchanged. If it was created for the HostGator host, check Web Analytics still reports after cutover.
- Don't upload `public/index.html` to HostGator: it calls the API on its own origin.
