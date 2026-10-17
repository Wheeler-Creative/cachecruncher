(() => {
  const root = document.querySelector("[data-ww-order-history]");
  if (!root) return;
  let token = location.hash.slice(1);
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  let cursor = "", previous = [], busy = false;
  const node = (tag, text = "", props = {}) => {
    const element = document.createElement(tag); element.textContent = text;
    for (const [key, value] of Object.entries(props)) if (key.startsWith("on")) element.addEventListener(key.slice(2), value); else element.setAttribute(key, value);
    return element;
  };
  const button = (text, action) => node("button", text, { type: "button", onclick: action });
  const status = (text, error = false) => node("p", text, { role: error ? "alert" : "status" });
  const money = (amount, currency) => {
    if (amount == null) return "";
    const format = new Intl.NumberFormat(undefined, { style: "currency", currency });
    return format.format(amount / 10 ** format.resolvedOptions().maximumFractionDigits);
  };
  async function api(action, body = null, search = "") {
    const response = await fetch("/api/order-history/" + action + search, { method: body ? "POST" : "GET", credentials: "same-origin", headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || "Unable to load order history."), { status: response.status });
    return data;
  }
  const heading = () => node("h1", "Order history");
  // Product pages on this site say what was already ordered.
  function rememberOrdered(orders) {
    try {
      const saved = JSON.parse(localStorage.getItem("ww-store-ordered") || "null");
      const items = Array.isArray(saved?.items) ? saved.items : [];
      const known = new Set(items.map(item => item.productId + ":" + item.at));
      for (const order of orders) for (const item of order.lineItems || []) {
        const at = Date.parse(order.createdAt);
        if (item.productId && Number.isFinite(at) && !known.has(item.productId + ":" + at)) items.push({ productId: item.productId, quantity: item.quantity, at });
      }
      localStorage.setItem("ww-store-ordered", JSON.stringify({ items: items.slice(-200) }));
    } catch { /* storage may be unavailable */ }
  }
  function emailForm(message = "", error = false) {
    const form = node("form"), label = node("label", "Email address"), email = node("input", "", { type: "email", name: "email", autocomplete: "email", required: "", maxlength: "254" });
    label.append(email); const submit = node("button", "Send access link", { type: "submit" });
    form.append(label, submit);
    form.addEventListener("submit", async event => {
      event.preventDefault(); if (busy) return; busy = true; submit.disabled = true;
      const feedback = status("Sending..."); form.append(feedback);
      try { const result = await api("request", { email: email.value }); feedback.textContent = result.message; }
      catch (failure) { feedback.setAttribute("role", "alert"); feedback.textContent = failure.message; }
      finally { busy = false; submit.disabled = false; }
    });
    root.replaceChildren(heading(), ...(message ? [status(message, error)] : []), form);
  }
  async function load() {
    root.replaceChildren(heading(), status("Loading orders..."));
    try {
      const data = await api("list", null, "?" + new URLSearchParams({ limit: "25", cursor }));
      rememberOrdered(data.orders || []);
      const list = node("div", "", { class: "ww-order-list" });
      for (const order of data.orders || []) {
        const detail = node("details"), summary = node("summary");
        summary.append(node("strong", order.orderNumber || order.id.slice(0, 8)), node("time", new Date(order.createdAt).toLocaleDateString(), { datetime: order.createdAt }),
          node("span", order.cancelledAt ? "Cancelled" : order.sourceStatus || order.status), node("span", money(order.totalAmount, order.currency), { class: "ww-order-amount" }));
        detail.append(summary);
        if (order.fulfillment) {
          const labels = { waiting: "Awaiting release", ready: "Ready to fulfill", in_progress: "In progress", partial: "Partially fulfilled", fulfilled: "Fulfilled" };
          summary.append(node("span", labels[order.fulfillment.status] || order.fulfillment.status));
          detail.append(node("p", `${order.fulfillment.fulfilled} of ${order.fulfillment.quantity} fulfilled`));
        }
        if (order.origin === "imported") detail.append(node("p", "Imported from " + order.provider));
        if (order.fulfillmentStatus) detail.append(node("p", order.fulfillmentStatus));
        const items = node("ul");
        for (const item of order.lineItems || []) {
          const line = node("li", `${item.quantity} x ${[item.title, item.variantLabel].filter(Boolean).join(" - ")} ${item.unitAmount == null ? "" : money(item.unitAmount * item.quantity, item.currency || order.currency)}`);
          if (item.fulfilledQuantity != null) line.append(node("p", `${item.fulfilledQuantity} fulfilled, ${item.remainingQuantity} remaining${item.awaitingRelease && item.remainingQuantity ? " · Awaiting release" : ""}`));
          if (item.releaseAt) line.append(node("p", "Release date: " + new Date(item.releaseAt).toLocaleDateString()));
          items.append(line);
        }
        detail.append(items);
        for (const [key, label] of [["shippingAmount", "Shipping"], ["taxAmount", "Tax"], ["discountAmount", "Discount"], ["refundedAmount", "Refunded"]]) if (order[key] != null) detail.append(node("p", label + ": " + money(order[key], order.currency)));
        list.append(detail);
      }
      const controls = node("nav", "", { "aria-label": "Order pages", class: "ww-order-actions" });
      const back = button("Previous", () => { cursor = previous.pop(); load(); }); back.disabled = !previous.length;
      const next = button("Next", () => { previous.push(cursor); cursor = data.nextCursor; load(); }); next.disabled = !data.nextCursor;
      controls.append(back, next);
      root.replaceChildren(heading(), button("Sign out", async () => {
        try { await api("logout", {}); cursor = ""; previous = []; emailForm(); } catch (error) { root.append(status(error.message, true)); }
      }), ...(data.orders?.length ? [list] : [status("No orders found.")]), controls);
    } catch (error) {
      if (error.status === 401) emailForm();
      else root.replaceChildren(heading(), status(error.message, true), button("Retry", load));
    }
  }
  if (token) {
    const continueButton = button("Continue to order history", async () => {
      if (busy) return; busy = true; continueButton.disabled = true;
      try { await api("redeem", { token }); token = ""; await load(); }
      catch (error) { token = ""; emailForm(error.message, true); }
      finally { busy = false; }
    });
    root.replaceChildren(heading(), continueButton);
  } else load();
})();