import type { Metadata } from "next";
import LegalPage from "../../components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Privacy Policy | FB Multi-Page Publisher",
  description:
    "Privacy policy for the FB Multi-Page Publisher application.",
};

export const dynamic = "force-static";

const headingStyle = {
  marginTop: "28px",
  marginBottom: "10px",
  fontSize: "1.35rem",
} as const;

const linkStyle = {
  color: "#4f46e5",
  fontWeight: 700,
} as const;

export default function PrivacyPolicyPage() {
  return (
    <LegalPage title="Privacy Policy" lastUpdated="July 19, 2026">
      <p>
        This Privacy Policy explains how FB Multi-Page Publisher
        (&quot;the Service&quot;, &quot;we&quot;, &quot;us&quot;, or
        &quot;our&quot;) collects, uses, stores, and protects information when
        you use staudtmaxturtle.com.
      </p>

      <h2 style={headingStyle}>1. Information we collect</h2>
      <p>We may collect and process the following categories of information:</p>
      <ul>
        <li>
          Account information, such as your name, email address, authentication
          details, account status, and role.
        </li>
        <li>
          Meta and Facebook information that you authorize, including your
          Facebook user ID, connected Facebook Pages, Page names, Page IDs,
          Page categories, access-token expiry information, and encrypted
          access tokens.
        </li>
        <li>
          Google Drive connection information that you authorize, including
          account email, folder identifiers, connection status, and encrypted
          OAuth refresh tokens.
        </li>
        <li>
          Uploaded-media information, including filenames, sizes, formats,
          durations, codecs, dimensions, validation results, storage
          identifiers, publishing schedules, titles, captions, and hashtags.
        </li>
        <li>
          Technical and security information, including audit logs, IP
          addresses when available, error messages, timestamps, and worker or
          publishing activity.
        </li>
      </ul>

      <h2 style={headingStyle}>2. How we use information</h2>
      <p>We use information to:</p>
      <ul>
        <li>create and secure user accounts;</li>
        <li>connect authorized Meta, Facebook, and Google Drive accounts;</li>
        <li>upload, validate, store, schedule, and publish media;</li>
        <li>display connected Pages and publishing history;</li>
        <li>prevent abuse, investigate errors, and maintain service security;</li>
        <li>respond to support and data-deletion requests; and</li>
        <li>comply with legal obligations.</li>
      </ul>

      <h2 style={headingStyle}>3. Tokens and sensitive credentials</h2>
      <p>
        Access tokens, refresh tokens, and application secrets are intended to
        be encrypted before storage. We do not intentionally display stored
        secret values in the user interface. Users must not share passwords,
        access tokens, application secrets, or encryption keys with anyone.
      </p>

      <h2 style={headingStyle}>4. Sharing of information</h2>
      <p>
        We do not sell personal information. Information may be shared with
        service providers only as needed to operate the Service, including
        Meta/Facebook for Page authorization and publishing, Google for Drive
        storage and OAuth, hosting providers, database providers, and security
        or infrastructure vendors. We may also disclose information when
        required by law or to protect users, the Service, or the public.
      </p>

      <h2 style={headingStyle}>5. Data retention</h2>
      <p>
        We retain information only for as long as reasonably necessary to
        provide the Service, maintain security and audit records, resolve
        disputes, or meet legal obligations. Uploaded media and publishing
        records may be retained according to account settings, storage
        policies, or operational requirements.
      </p>

      <h2 style={headingStyle}>6. Data security</h2>
      <p>
        We use reasonable administrative and technical safeguards, including
        access controls, encrypted secret storage, account isolation, and audit
        logging. No internet service can guarantee complete security, so users
        should also protect their accounts and connected third-party services.
      </p>

      <h2 style={headingStyle}>7. Your choices and rights</h2>
      <p>
        You may request access, correction, disconnection, or deletion of
        eligible account data. Instructions are available on our{" "}
        <a href="/data-deletion" style={linkStyle}>
          Data Deletion page
        </a>
        . You may also remove the app from your Facebook or Google account
        settings to stop future access.
      </p>

      <h2 style={headingStyle}>8. Third-party services</h2>
      <p>
        Meta, Facebook, Google, and other third parties operate under their own
        terms and privacy policies. We are not responsible for their
        independent practices, availability, or policy decisions.
      </p>

      <h2 style={headingStyle}>9. Children</h2>
      <p>
        The Service is not intended for children under 18. We do not knowingly
        collect personal information from children.
      </p>

      <h2 style={headingStyle}>10. Changes to this policy</h2>
      <p>
        We may update this Privacy Policy when the Service or our practices
        change. The updated date at the top of this page will show the latest
        revision.
      </p>

      <h2 style={headingStyle}>11. Contact</h2>
      <p>
        Privacy and data questions may be sent to{" "}
        <a href="mailto:zedde934@gmail.com" style={linkStyle}>
          zedde934@gmail.com
        </a>
        .
      </p>
    </LegalPage>
  );
}
