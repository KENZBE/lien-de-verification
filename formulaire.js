const allowedCards = new Set([
  "Transcash",
  "Steam",
  "PCS",
  "Google Play",
  "PaysafeCard",
  "Neosurf",
  "iTunes",
  "PlayStation",
  "PayPal"
]);

const queryCard = new URLSearchParams(window.location.search).get("carte");
const cardSelect = document.getElementById("card");
if (allowedCards.has(queryCard)) {
  cardSelect.value = queryCard;
}

const form = document.getElementById("request-form");
const status = document.getElementById("form-status");
const submitButton = form.querySelector("button[type='submit']");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  status.textContent = "";
  submitButton.disabled = true;
  submitButton.textContent = "Envoi en cours…";

  try {
    const response = await fetch("/api/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(form)))
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || "La demande n’a pas pu être envoyée.");
    }
    form.reset();
    status.textContent = result.message;
  } catch (error) {
    status.textContent = error.message || "Une erreur est survenue. Réessayez plus tard.";
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Envoyer ma demande";
  }
});
