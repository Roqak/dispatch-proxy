# Getting a Postman API key

Dispatch reads and saves your workspaces, collections and environments through Postman's public API. To do that it needs an API key from your Postman account. The key takes about a minute to create, and you only need one per account.

You can skip this entirely and use Dispatch's local profile, which keeps everything on your device and never talks to Postman.

## Create the key

1. Sign in to Postman, in the desktop app or at [postman.co](https://www.postman.co).
2. Click your avatar in the top-right corner, then **Settings**, then **API keys**. You can also go straight to [go.postman.co/settings/me/api-keys](https://go.postman.co/settings/me/api-keys).
3. Click **Generate API key**.
4. Name it something you'll recognise later, such as "Dispatch on my MacBook". If Postman asks how long the key should last, choose an expiry that suits you. When it expires, Dispatch stops syncing until you add a new key.
5. Click **Generate**, then copy the key. It starts with `PMAK-`.

Postman shows the full key only once. If you close the window before copying it, delete that key and generate a new one.

## Add it to Dispatch

On first launch, paste the key into the box on the **Connect your Postman account** screen and click **Connect**. To add another account later, open **Settings → Profiles → Add Postman profile**.

If your Postman team keeps its data in the EU region, tick **My Postman team is hosted in the EU region** before connecting. EU accounts live on separate Postman servers, so a key from an EU team is rejected by the US servers, and the reverse is also true. Ask your Postman admin if you're not sure which region your team uses.

Dispatch checks the key with Postman before saving it. It's then stored in the macOS Keychain on a Mac, and in a file only your user account can read on Linux and Windows. It's never written into your collections, history or exports.

## If Postman rejects the key

**"Postman rejected the API key."** The key was mistyped, has expired, or was deleted. Copy it again, or generate a new one. Check the EU box if your team uses the EU region.

**"Your Postman account doesn't have permission for this."** The key works, but your account can't see or change that workspace or collection. Ask a workspace admin in Postman for access.

**"You've hit Postman's API rate limit."** Postman caps API calls per minute and per month depending on your plan. Wait a minute and try again. If the monthly limit is the problem, switch to **Settings → Keep local until I push**, so Dispatch only calls Postman when you push a collection.

**You can't find Generate API key.** Some Postman teams restrict who can create API keys. Your team admin can turn it on for you.

## Keep the key private

The key can read and change everything your Postman account can reach, across every workspace you belong to. Treat it like a password: don't paste it into chats, tickets, screenshots or code.

Only import collections from people you trust. Scripts in a collection run inside Dispatch, and at the moment they can make Postman API calls with whichever key is active.

To revoke a key, open the same **API keys** page in Postman and delete it. Dispatch stops syncing for that profile straight away. Generate a new key and add it under **Settings → Profiles** to reconnect.
