// Enroll page. The one-time token comes in the URL fragment (or ?t=), which
// browsers never send to the server. It's removed from the address bar at once.
import { createPasskey, post } from "/webauthn.js";

const $ = (sel) => document.querySelector(sel);
const token = location.hash.slice(1) || new URLSearchParams(location.search).get("t");
history.replaceState(null, "", "/enroll");

function setStatus(text) {
  $("#status").textContent = text;
}

if (!token) {
  $("#create").disabled = true;
  setStatus("This page needs a setup link. Make one with scripts/enroll-link.mjs.");
} else if (!window.PublicKeyCredential) {
  $("#create").disabled = true;
  setStatus("This browser doesn't support passkeys.");
}

$("#create").addEventListener("click", async () => {
  $("#create").disabled = true;
  setStatus("Waiting for your device…");
  try {
    const options = await post("/api/auth/register/options", { token });
    const response = await createPasskey(options);
    await post("/api/auth/register/verify", { token, response });
    setStatus("Passkey saved. Opening your inbox…");
    location.replace("/");
  } catch (err) {
    setStatus(`Couldn't set up the passkey: ${err.message}`);
    $("#create").disabled = false;
  }
});
