// Support request modal (views/partials/support-modal.ejs, DECISIONS.md "Support requests").
// Opened by the Support request nav item (Bootstrap data-bs-toggle) or any [data-support-open]
// element. On send the modal hides, the browser's own screen capture (getDisplayMedia) grabs the
// tab, and everything posts to /support as one multipart request. Cancelling the capture picker
// still sends the request, without a screenshot.
document.addEventListener("DOMContentLoaded", function ()
{
    var modalEl = document.getElementById("supportModal");
    if (!modalEl) { return; }
    var submitBtn = document.getElementById("supportSubmit");
    var descEl = document.getElementById("supportDescription");
    var errEl = document.getElementById("supportError");
    var formArea = document.getElementById("supportForm");
    var doneArea = document.getElementById("supportDone");
    var severityEl = document.getElementById("supportSeverity");
    var defaultSeverity = severityEl.value;

    function showError(text)
    {
        errEl.textContent = text;
        errEl.classList.remove("d-none");
        submitBtn.disabled = false;
    }

    // A readable name for the page: the breadcrumb (or the page title), then the active tab.
    function pageTitle()
    {
        var crumbs = Array.from(document.querySelectorAll(".iot-breadcrumb a, .iot-breadcrumb span:not(.mx-2)")).map(function (el) { return el.textContent.trim(); }).filter(Boolean);
        var h1 = document.querySelector(".iot-page-title");
        var name = crumbs.length ? crumbs.join(" / ") : (h1 ? h1.textContent.trim() : document.title);
        var tab = document.querySelector(".iot-subnav-link.active");
        return name + (tab ? ", " + tab.textContent.trim() : "");
    }

    // A fresh form every time it opens.
    modalEl.addEventListener("show.bs.modal", function ()
    {
        descEl.value = "";
        severityEl.value = defaultSeverity;
        document.getElementById("supportCopyMe").checked = false;
        document.getElementById("supportScreenshot").checked = true;
        document.getElementById("supportFile").value = "";
        document.getElementById("supportPage").textContent = pageTitle();
        errEl.classList.add("d-none");
        formArea.classList.remove("d-none");
        doneArea.classList.add("d-none");
        submitBtn.classList.remove("d-none");
        submitBtn.disabled = false;
    });
    modalEl.addEventListener("shown.bs.modal", function () { descEl.focus(); });

    document.addEventListener("click", function (e)
    {
        var opener = e.target.closest("[data-support-open]");
        if (!opener) { return; }
        e.preventDefault();
        bootstrap.Modal.getOrCreateInstance(modalEl).show();
    });

    // The tab via the browser's own capture; the modal is hidden while it is taken.
    async function captureScreenshot()
    {
        var backdrop = document.querySelector(".modal-backdrop");
        try
        {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) { return null; }
            modalEl.style.visibility = "hidden";
            if (backdrop) { backdrop.style.visibility = "hidden"; }
            var stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "browser" }, preferCurrentTab: true, audio: false });
            var track = stream.getVideoTracks()[0];
            var video = document.createElement("video");
            video.srcObject = stream;
            video.muted = true;
            await video.play();
            var canvas = document.createElement("canvas");
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            canvas.getContext("2d").drawImage(video, 0, 0);
            track.stop();
            return await new Promise(function (resolve) { canvas.toBlob(function (blob) { resolve(blob); }, "image/jpeg", 0.85); });
        }
        catch (e)
        {
            return null;    // declined or failed: the request still goes, without a screenshot
        }
        finally
        {
            modalEl.style.visibility = "";
            if (backdrop) { backdrop.style.visibility = ""; }
        }
    }

    submitBtn.addEventListener("click", async function ()
    {
        var description = descEl.value.trim();
        if (!description) { showError("Please describe the problem."); return; }
        var fileInput = document.getElementById("supportFile");
        var maxBytes = Number(modalEl.dataset.maxMb) * 1048576;
        if (fileInput.files.length && fileInput.files[0].size > maxBytes) { showError("Files must be under " + modalEl.dataset.maxMb + " MB."); return; }
        submitBtn.disabled = true;
        errEl.classList.add("d-none");

        var screenshot = null;
        if (document.getElementById("supportScreenshot").checked) { screenshot = await captureScreenshot(); }

        try
        {
            var fd = new FormData();
            fd.append("description", description);
            fd.append("severity", severityEl.value);
            fd.append("pageUrl", location.pathname + location.search);
            fd.append("pageTitle", document.getElementById("supportPage").textContent);
            fd.append("viewport", window.innerWidth + "x" + window.innerHeight);
            fd.append("copyMe", document.getElementById("supportCopyMe").checked ? "true" : "false");
            fd.append("accountUid", modalEl.dataset.account || "");
            fd.append("locationUid", modalEl.dataset.location || "");
            if (fileInput.files.length) { fd.append("file", fileInput.files[0]); }
            if (screenshot) { fd.append("screenshot", screenshot, "screenshot.jpg"); }

            // No content-type header: the browser sets the multipart boundary itself.
            var res = await fetch("/support", { method: "POST", body: fd, credentials: "same-origin", headers: { "x-csrf-token": modalEl.dataset.csrf, "accept": "application/json" } });
            var data = null;
            try { data = await res.json(); } catch (e) { data = null; }
            if (res.ok && data && data.ok)
            {
                document.getElementById("supportNumber").textContent = data.number;
                document.getElementById("supportLink").href = data.link;
                formArea.classList.add("d-none");
                doneArea.classList.remove("d-none");
                submitBtn.classList.add("d-none");
                return;
            }
            if (data && data.error) { showError(data.error); }
            else if (res.status === 403) { showError("The page has expired. Reload it and send the request again."); }
            else { showError("Could not send the request (" + res.status + "). Please try again."); }
        }
        catch (e)
        {
            showError("Could not send the request. Please try again.");
        }
    });
});
