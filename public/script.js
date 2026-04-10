const loginView = document.getElementById("loginView");
const appView = document.getElementById("appView");
const loginForm = document.getElementById("loginForm");
const loginMessage = document.getElementById("loginMessage");
const cidInput = document.getElementById("cid");
const welcomeText = document.getElementById("welcomeText");
const roleText = document.getElementById("roleText");
const menuGrid = document.getElementById("menuGrid");
const addMenuBtn = document.getElementById("addMenuBtn");
const logoutBtn = document.getElementById("logoutBtn");

const menuModal = document.getElementById("menuModal");
const menuForm = document.getElementById("menuForm");
const modalTitle = document.getElementById("modalTitle");
const cancelModal = document.getElementById("cancelModal");
const menuIdInput = document.getElementById("menuId");
const menuTitle = document.getElementById("menuTitle");
const menuUrl = document.getElementById("menuUrl");
const menuDescription = document.getElementById("menuDescription");
const menuIcon = document.getElementById("menuIcon");
const menuColor = document.getElementById("menuColor");

let currentUser = null;
let menus = [];

function setLoginMessage(text, isError = true) {
  loginMessage.style.color = isError ? "#ffb4a2" : "#e9edc9";
  loginMessage.textContent = text;
}

function showView(isLoggedIn) {
  loginView.classList.toggle("hidden", isLoggedIn);
  appView.classList.toggle("hidden", !isLoggedIn);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || "Request failed");
  return data;
}

function renderMenus() {
  menuGrid.innerHTML = "";
  for (const menu of menus) {
    const card = document.createElement("article");
    card.className = "menu-card";
    card.dataset.id = menu.id;
    card.style.background = `linear-gradient(140deg, ${menu.color || "#0a9396"} 0%, #001219 90%)`;

    const canEdit = Boolean(currentUser?.isAdmin);
    card.innerHTML = `
      <div class="icon">${(menu.icon || "APP").slice(0, 6)}</div>
      <div class="title">${menu.title || "-"}</div>
      <div class="desc">${menu.description || ""}</div>
      ${
        canEdit
          ? `<div class="card-actions">
        ${canEdit ? `<button class="secondary edit-btn" data-id="${menu.id}">แก้ไข</button>` : ""}
        ${canEdit ? `<button class="danger del-btn" data-id="${menu.id}">ลบ</button>` : ""}
      </div>`
          : ""
      }
    `;
    menuGrid.appendChild(card);
  }
}

function openCreateModal() {
  modalTitle.textContent = "เพิ่มเมนู";
  menuIdInput.value = "";
  menuTitle.value = "";
  menuUrl.value = "";
  menuDescription.value = "";
  menuIcon.value = "";
  menuColor.value = "#0a9396";
  menuModal.showModal();
}

function openEditModal(menu) {
  modalTitle.textContent = "แก้ไขเมนู";
  menuIdInput.value = menu.id;
  menuTitle.value = menu.title || "";
  menuUrl.value = menu.url || "";
  menuDescription.value = menu.description || "";
  menuIcon.value = menu.icon || "";
  menuColor.value = menu.color || "#0a9396";
  menuModal.showModal();
}

async function loadProfileAndMenus() {
  const profile = await api("/api/me");
  currentUser = profile.user;
  if (!currentUser) {
    showView(false);
    return;
  }

  welcomeText.textContent = `สวัสดีผู้ใช้ ${currentUser.name || currentUser.cid}`;
  roleText.textContent = currentUser.isAdmin ? "สิทธิ์: ผู้ดูแลระบบ" : "สิทธิ์: ผู้ใช้งานทั่วไป";
  addMenuBtn.classList.toggle("hidden", !currentUser.isAdmin);

  const data = await api("/api/menus");
  menus = data.menus || [];
  renderMenus();
  showView(true);
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const cid = cidInput.value.trim();
  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ cid })
    });
    setLoginMessage("");
    cidInput.value = "";
    await loadProfileAndMenus();
  } catch (error) {
    setLoginMessage(error.message, true);
  }
});

logoutBtn.addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  currentUser = null;
  showView(false);
  setLoginMessage("");
});

addMenuBtn.addEventListener("click", openCreateModal);
cancelModal.addEventListener("click", () => menuModal.close());

menuGrid.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const card = target.closest(".menu-card");
  if (!card) return;

  const id = card.dataset.id;
  const menu = menus.find((m) => m.id === id);
  if (!menu) return;

  if (target.classList.contains("edit-btn")) {
    openEditModal(menu);
    return;
  }

  if (target.classList.contains("del-btn")) {
    const ok = window.confirm(`ยืนยันลบเมนู "${menu.title}" ?`);
    if (!ok) return;
    try {
      await api(`/api/menus/${menu.id}`, { method: "DELETE" });
      await loadProfileAndMenus();
    } catch (error) {
      alert(error.message);
    }
    return;
  }

  window.open(menu.url, "_blank");
});

menuForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const payload = {
    title: menuTitle.value.trim(),
    url: menuUrl.value.trim(),
    description: menuDescription.value.trim(),
    icon: menuIcon.value.trim(),
    color: menuColor.value
  };

  try {
    if (menuIdInput.value) {
      await api(`/api/menus/${menuIdInput.value}`, {
        method: "PUT",
        body: JSON.stringify(payload)
      });
    } else {
      await api("/api/menus", {
        method: "POST",
        body: JSON.stringify(payload)
      });
    }
    menuModal.close();
    await loadProfileAndMenus();
  } catch (error) {
    alert(error.message);
  }
});

loadProfileAndMenus().catch(() => showView(false));
