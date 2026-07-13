# Custom Domain Production Deployment Steps

Follow these steps to deploy and configure the Facebook Multi-Page Publisher with a permanent custom domain or subdomain using Cloudflare:

## 1. Create a Cloudflare Named Tunnel
- Log into your Cloudflare Dashboard and navigate to **Zero Trust** -> **Networks** -> **Tunnels**.
- Create a new Named Tunnel (e.g., `fb-publisher-tunnel`).
- Install and configure the Cloudflare connector agent (`cloudflared`) on your hosting server following Cloudflare's instructions.

## 2. Map a Permanent Subdomain to localhost:3000
- In the Cloudflare Tunnel configuration settings, add a **Public Hostname**.
- Select or enter your custom domain or subdomain (e.g., `publisher.yourdomain.com`).
- Configure the service to point to the local server port:
  - **Type**: `HTTP`
  - **URL**: `localhost:3000` or `127.0.0.1:3000`
- Save the configuration. Cloudflare will automatically handle the HTTPS SSL certificate.

## 3. Enter the Permanent URL in Meta Configuration
- Open the application console via your custom domain (e.g., `https://publisher.yourdomain.com`).
- Navigate to **Settings** -> **Meta Configuration**.
- In the **Public Application URL** field, enter your full custom domain (e.g., `https://publisher.yourdomain.com`). Ensure you use HTTPS.
- Click **Save Settings**.

## 4. Copy the Generated Callback to Meta Valid OAuth Redirect URIs
- On the same Meta Configuration page in the publisher dashboard, copy the computed **Generated OAuth Callback URL** (e.g., `https://publisher.yourdomain.com/api/auth/facebook/callback`).
- Go to the [Meta App Developer Dashboard](https://developers.facebook.com/).
- Navigate to **Facebook Login** -> **Settings**.
- Paste the copied URL into the **Valid OAuth Redirect URIs** list.
- Save your changes in the Meta dashboard.

## 5. Add the Permanent Hostname to Meta App Domains
- Inside the Meta App Developer Dashboard, go to **App Settings** -> **Basic**.
- In the **App Domains** field, add your permanent domain (e.g., `yourdomain.com` or `publisher.yourdomain.com`).
- Scroll to the bottom and save the settings.

## 6. Test Configuration
- Go back to the Meta Configuration settings page inside the publisher application.
- Click **Test Configuration** to run an automated check confirming the credentials, URL formatting, and callback configuration parameters.

## 7. Connect Facebook Accounts
- Navigate to the publisher homepage or connection manager.
- Click **Connect Facebook Account** to trigger the secure login dialog.
- Accept permissions to link your multiple Facebook accounts.
