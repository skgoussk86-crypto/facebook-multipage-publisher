import type { Metadata } from "next";
import LegalPage from "../../components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Terms of Service | FB Multi-Page Publisher",
  description:
    "Terms of service for the FB Multi-Page Publisher application.",
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

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" lastUpdated="July 19, 2026">
      <p>
        These Terms of Service govern your use of FB Multi-Page Publisher
        (&quot;the Service&quot;) at staudtmaxturtle.com. By creating an
        account, connecting a third-party service, or using the Service, you
        agree to these Terms.
      </p>

      <h2 style={headingStyle}>1. Eligibility and accounts</h2>
      <p>
        You must be at least 18 years old and legally able to enter into these
        Terms. You are responsible for the accuracy of your account
        information, the security of your credentials, and all actions
        performed through your account.
      </p>

      <h2 style={headingStyle}>2. Authorized use</h2>
      <p>
        You may use the Service only for Facebook Pages, Google Drive accounts,
        media, and other resources that you own or are authorized to manage.
        You must comply with all applicable laws and the policies of Meta,
        Facebook, Google, and any other connected provider.
      </p>

      <h2 style={headingStyle}>3. Your content</h2>
      <p>
        You retain ownership of content you upload. You grant the Service the
        limited permission needed to receive, validate, store, process,
        schedule, transmit, and publish that content according to your
        instructions.
      </p>
      <p>
        You are solely responsible for ensuring that your content does not
        violate copyright, trademark, privacy, publicity, platform, community,
        advertising, or other rights and rules.
      </p>

      <h2 style={headingStyle}>4. Prohibited activity</h2>
      <p>You must not use the Service to:</p>
      <ul>
        <li>access or manage accounts or Pages without authorization;</li>
        <li>publish illegal, deceptive, infringing, or abusive content;</li>
        <li>bypass security, rate limits, account restrictions, or platform review;</li>
        <li>upload malware or attempt to interfere with the Service;</li>
        <li>sell, transfer, or expose tokens, secrets, or user credentials; or</li>
        <li>use the Service in a manner that creates unreasonable risk or load.</li>
      </ul>

      <h2 style={headingStyle}>5. Connected services</h2>
      <p>
        The Service depends on third-party APIs and systems, including Meta,
        Facebook, Google, hosting, storage, and database providers. Their
        outages, restrictions, policy changes, token expirations, reviews, or
        enforcement actions may affect the Service. We do not control those
        systems.
      </p>

      <h2 style={headingStyle}>6. Availability and changes</h2>
      <p>
        We may modify, suspend, limit, or discontinue features for maintenance,
        security, compliance, or operational reasons. Scheduled publishing is
        not guaranteed to occur at an exact second because it may depend on
        worker availability, provider processing, network conditions, and
        third-party APIs.
      </p>

      <h2 style={headingStyle}>7. Suspension and termination</h2>
      <p>
        We may suspend or terminate access when an account violates these
        Terms, creates security or legal risk, abuses the Service, or is
        required to be restricted by a third party or authority.
      </p>

      <h2 style={headingStyle}>8. Disclaimers</h2>
      <p>
        The Service is provided on an &quot;as is&quot; and &quot;as
        available&quot; basis. To the maximum extent permitted by law, we
        disclaim warranties regarding uninterrupted operation, error-free
        publishing, third-party availability, fitness for a particular
        purpose, and non-infringement.
      </p>

      <h2 style={headingStyle}>9. Limitation of liability</h2>
      <p>
        To the maximum extent permitted by law, we will not be liable for
        indirect, incidental, special, consequential, exemplary, or punitive
        damages, or for lost content, revenue, profits, data, audience access,
        or publishing opportunities arising from use of the Service or a
        connected third-party platform.
      </p>

      <h2 style={headingStyle}>10. Privacy and deletion</h2>
      <p>
        Our{" "}
        <a href="/privacy" style={linkStyle}>
          Privacy Policy
        </a>{" "}
        explains how information is handled. Data-deletion instructions are
        available on the{" "}
        <a href="/data-deletion" style={linkStyle}>
          Data Deletion page
        </a>
        .
      </p>

      <h2 style={headingStyle}>11. Changes to these Terms</h2>
      <p>
        We may update these Terms as the Service changes. Continued use after
        an update means you accept the revised Terms.
      </p>

      <h2 style={headingStyle}>12. Contact</h2>
      <p>
        Questions about these Terms may be sent to{" "}
        <a href="mailto:zedde934@gmail.com" style={linkStyle}>
          zedde934@gmail.com
        </a>
        .
      </p>
    </LegalPage>
  );
}
