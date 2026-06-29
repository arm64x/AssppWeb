import { useTranslation } from "react-i18next";
import { useAccounts } from "./useAccounts";
import { useToastStore } from "../store/toast";
import { useDownloadsStore } from "../store/downloads";
import { getDownloadInfo } from "../apple/download";
import { purchaseApp } from "../apple/purchase";
import { authenticate } from "../apple/authenticate";
import { apiPost, apiGet } from "../api/client";
import { accountHash } from "../utils/account";
import { getErrorMessage } from "../utils/error";
import { getAccountContext } from "../utils/toast";
import type { Account, Software } from "../types";

/**
 * Shared hook for download & purchase actions.
 * Eliminates the duplicated flow across ProductDetail, VersionHistory, and AddDownload.
 */
export function useDownloadAction() {
  const { updateAccount } = useAccounts();
  const addToast = useToastStore((s) => s.addToast);
  const fetchTasks = useDownloadsStore((s) => s.fetchTasks);
  const { t } = useTranslation();

  async function startDownload(
    account: Account,
    app: Software,
    versionId?: string,
  ) {
    const ctx = getAccountContext(account, t);

    try {
      const settings = await apiGet<{ maxDownloadMB: number }>("/api/settings");
      if (settings.maxDownloadMB > 0 && app.fileSizeBytes) {
        const sizeMB = parseInt(app.fileSizeBytes, 10) / (1024 * 1024);
        if (sizeMB > settings.maxDownloadMB) {
          addToast(
            t("toast.downloadLimit.message", {
              appName: app.name || String(app.id),
              size: sizeMB.toFixed(2),
              limit: settings.maxDownloadMB,
            }),
            "error",
            t("toast.title.downloadLimit"),
          );
          return;
        }
      }
    } catch {
      // Settings fetch failed — backend will still enforce the limit
    }

    const { output, updatedCookies } = await getDownloadInfo(
      account,
      app,
      versionId,
    );
    await updateAccount({ ...account, cookies: updatedCookies });
    const hash = await accountHash(account);

    // Fill in real name/bundleID/icon/artist recovered from Apple's own
    // response. This only overrides fields the caller left blank (e.g.
    // the App ID stub), so a real lookup result is never clobbered. If
    // Apple's response is missing a field too, fall back to the numeric
    // Adam ID rather than leaving name/bundleID empty.
    const resolved = output.resolvedSoftware ?? {};
    const fallbackId = String(app.id);
    const resolvedApp: Software = {
      ...app,
      version: output.bundleShortVersionString,
      name: app.name || resolved.name || fallbackId,
      bundleID: app.bundleID || resolved.bundleID || fallbackId,
      artistName: app.artistName || resolved.artistName || app.artistName,
      artworkUrl: app.artworkUrl || resolved.artworkUrl || app.artworkUrl,
      primaryGenreName:
        app.primaryGenreName || resolved.primaryGenreName || app.primaryGenreName,
    };
    const appName = resolvedApp.name;

    await apiPost("/api/downloads", {
      software: resolvedApp,
      accountHash: hash,
      downloadURL: output.downloadURL,
      sinfs: output.sinfs,
      iTunesMetadata: output.iTunesMetadata,
    });

    fetchTasks();

    addToast(
      t("toast.msg", { appName, ...ctx }),
      "info",
      t("toast.title.downloadStarted"),
    );
  }

  async function acquireLicense(account: Account, app: Software) {
    const ctx = getAccountContext(account, t);
    const appName = app.name;

    // Silently renew the password token before purchasing.
    // This prevents "token expired" (2034/2042) errors that would
    // otherwise require the user to manually re-authenticate.
    let currentAccount = account;
    try {
      const renewed = await authenticate(
        account.email,
        account.password,
        undefined,
        account.cookies,
        account.deviceIdentifier,
      );
      await updateAccount(renewed);
      currentAccount = renewed;
    } catch {
      // Ignore — proceed with existing token
    }

    const result = await purchaseApp(currentAccount, app);
    await updateAccount({ ...currentAccount, cookies: result.updatedCookies });

    addToast(
      t("toast.msg", { appName, ...ctx }),
      "success",
      t("toast.title.licenseSuccess"),
    );
  }

  function toastDownloadError(account: Account, app: Software, error: unknown) {
    const ctx = getAccountContext(account, t);
    addToast(
      t("toast.msgFailed", {
        appName: app.name || String(app.id),
        ...ctx,
        error: getErrorMessage(error, t("toast.title.downloadFailed")),
      }),
      "error",
      t("toast.title.downloadFailed"),
    );
  }

  function toastLicenseError(account: Account, app: Software, error: unknown) {
    const ctx = getAccountContext(account, t);
    addToast(
      t("toast.msgFailed", {
        appName: app.name,
        ...ctx,
        error: getErrorMessage(error, t("toast.title.licenseFailed")),
      }),
      "error",
      t("toast.title.licenseFailed"),
    );
  }

  return {
    startDownload,
    acquireLicense,
    toastDownloadError,
    toastLicenseError,
  };
}
