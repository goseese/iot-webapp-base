/*
 * iot-ui.js
 * Flash messages (toasts) and confirm dialog for the IoT theme.
 * Requires bootstrap.bundle.min.js loaded first.
 */

(function ()
{
    "use strict";

    var ICONS =
    {
        success: "fa-circle-check",
        warning: "fa-triangle-exclamation",
        danger:  "fa-circle-xmark",
        info:    "fa-circle-info"
    };

    /* ------------------------------------------------------------------
       Flash messages
       iotFlash("success", "Location saved.");
       iotFlash("danger",  "Could not reach the gateway.");
       Options: { delay: ms, autohide: bool }
       ------------------------------------------------------------------ */
    function getStack()
    {
        var stack = document.querySelector(".iot-toast-stack");
        if (!stack)
        {
            stack = document.createElement("div");
            stack.className = "iot-toast-stack";
            document.body.appendChild(stack);
        }
        return stack;
    }

    window.iotFlash = function (type, message, options)
    {
        options = options || {};
        type = ICONS[type] ? type : "info";

        var autohide = (options.autohide !== undefined) ? options.autohide : (type !== "danger");
        var delay    = options.delay || 4000;

        var el = document.createElement("div");
        el.className = "toast iot-toast iot-toast--" + type;
        el.setAttribute("role", type === "danger" ? "alert" : "status");
        el.setAttribute("aria-live", type === "danger" ? "assertive" : "polite");
        el.innerHTML =
            '<div class="toast-body">' +
                '<i class="fa-solid ' + ICONS[type] + ' iot-toast__icon"></i>' +
                '<div class="iot-toast__text"></div>' +
                '<button type="button" class="btn-close btn-close-sm" data-bs-dismiss="toast" aria-label="Close"></button>' +
            '</div>';

        el.querySelector(".iot-toast__text").textContent = message;
        getStack().appendChild(el);

        var toast = new bootstrap.Toast(el, { autohide: autohide, delay: delay });
        el.addEventListener("hidden.bs.toast", function () { el.remove(); });
        toast.show();
        return toast;
    };

    /* ------------------------------------------------------------------
       Confirm dialog, returns a Promise<boolean>
       if (await iotConfirm({ title: "Delete device?", body: "...", danger: true })) { ... }
       ------------------------------------------------------------------ */
    function getConfirmModal()
    {
        var el = document.getElementById("iotConfirmModal");
        if (el) { return el; }

        el = document.createElement("div");
        el.className = "modal fade";
        el.id = "iotConfirmModal";
        el.tabIndex = -1;
        el.setAttribute("aria-hidden", "true");
        el.innerHTML =
            '<div class="modal-dialog modal-dialog-centered modal-sm">' +
              '<div class="modal-content">' +
                '<div class="modal-header">' +
                  '<h5 class="modal-title"></h5>' +
                  '<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>' +
                '</div>' +
                '<div class="modal-body"></div>' +
                '<div class="modal-footer">' +
                  '<button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal" data-role="cancel"></button>' +
                  '<button type="button" class="btn" data-role="confirm"></button>' +
                '</div>' +
              '</div>' +
            '</div>';
        document.body.appendChild(el);
        return el;
    }

    window.iotConfirm = function (options)
    {
        options = options || {};

        var el      = getConfirmModal();
        var modal   = bootstrap.Modal.getOrCreateInstance(el);
        var okBtn   = el.querySelector('[data-role="confirm"]');
        var noBtn   = el.querySelector('[data-role="cancel"]');

        el.querySelector(".modal-title").textContent = options.title || "Are you sure?";
        el.querySelector(".modal-body").textContent  = options.body  || "";
        okBtn.textContent = options.confirmText || "Confirm";
        noBtn.textContent = options.cancelText  || "Cancel";
        okBtn.className   = "btn " + (options.danger ? "btn-danger" : "btn-primary");

        return new Promise(function (resolve)
        {
            var result = false;

            function onConfirm()
            {
                result = true;
                modal.hide();
            }

            function onHidden()
            {
                okBtn.removeEventListener("click", onConfirm);
                el.removeEventListener("hidden.bs.modal", onHidden);
                resolve(result);
            }

            okBtn.addEventListener("click", onConfirm);
            el.addEventListener("hidden.bs.modal", onHidden);
            modal.show();
        });
    };

    /* ------------------------------------------------------------------
       Server-side flash on page load.
       In CI3:  <body data-iot-flash-type="success" data-iot-flash="Saved.">
       ------------------------------------------------------------------ */
    document.addEventListener("DOMContentLoaded", function ()
    {
        var msg = document.body.dataset.iotFlash;
        if (msg)
        {
            window.iotFlash(document.body.dataset.iotFlashType || "info", msg);
        }
    });
})();
