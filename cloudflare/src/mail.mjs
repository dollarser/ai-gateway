import { connect } from "cloudflare:sockets";
import { smtpSession } from "./smtp-core.mjs";
export async function sendRegistrationEmail(
  config,
  email,
  code,
  purpose = "verification",
) {
  const socket = connect(
    { hostname: config.smtp_host, port: 465 },
    { secureTransport: "on" },
  );
  return smtpSession(socket, config, email, code, purpose);
}
