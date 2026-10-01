// This script scrapes the cart items from a DoorDash order page and extracts the item name, price,
// and quantity for each item in the cart.
// It then logs the extracted data in a table format to the console.
const cartItems = Array.from(
  document.querySelectorAll(".ListCellContentContainer-sc-ayd32l-0.hDlkUo"),
);

const cartData = cartItems.map((item) => {
  // Extract Item Name
  const nameEl = item.querySelector(".sc-935e0fe8-4.eKcMSh");
  const name = nameEl ? nameEl.innerText.trim() : "Unknown";

  // Extract Price
  const priceEl = item.querySelector(".sc-935e0fe8-5.jzjftw");
  const price = priceEl ? Number(priceEl.innerText.trim().split("$")[1]) : 0;

  // Extract Quantity
  // Looks for the quantity number, often followed by "×"
  const quantityEl =
    item.querySelector('[data-testid="stepper-expanded-quantity"]') ||
    item.querySelector(".sc-e53969ac-0.iYXaPL span");

  let quantity = 1;
  if (quantityEl) {
    const qText = quantityEl.innerText.replace("×", "").trim();
    quantity = parseInt(qText, 10) || 1;
  }

  return { name, price, quantity };
});

console.table(cartData);
// Or copy as JSON: copy(cartData);
