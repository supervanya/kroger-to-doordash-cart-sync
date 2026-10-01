// This script is designed to scrape the cart items from a Kroger shopping cart page.
// It collects the name, current price, and quantity of each item in the cart and outputs the results in a table format.
const cartItems = Array.from(document.querySelectorAll("li.CartListItem"));

const result = cartItems
  .map((item) => {
    // Extract Name using the data-testid attribute identified from the structure
    const nameEl = item.querySelector(
      '[data-testid="cart-page-item-description"]',
    );
    const name = nameEl ? nameEl.innerText.trim() : null;

    // Extract Current Price (ignoring original price if it's on sale)
    const priceEl = item.querySelector(".citrus-Price--current-price");
    const priceNumber = priceEl
      ? Number(priceEl.innerText.trim().split("$")[1])
      : null;

    // Extract Quantity from the stepper input value
    const quantityInput = item.querySelector(
      '[data-testid="citrus-QuantityStepper-input"]',
    );
    const quantity = quantityInput ? parseInt(quantityInput.value, 10) : null;

    return {
      name,
      price: priceNumber,
      quantity,
    };
  })
  .filter((item) => item.name); // Filter out any empty rows or non-item elements

console.table(result);
