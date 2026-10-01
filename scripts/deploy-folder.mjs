#!/usr/bin/env node
/**
 * Deploy static directory to ESA (Assets mode)
 * Usage: node scripts/deploy-folder.mjs <name> <folder-path> [description]
 */
import { bootstrap } from "global-agent";
if (process.env.HTTPS_PROXY || process.env.https_proxy) bootstrap();

import Esa20240910 from "@alicloud/esa20240910";
import OpenApi from "@alicloud/openapi-client";
import TeaUtil from "@alicloud/tea-util";
import Credential from "@alicloud/credentials";
import JSZip from "jszip";
import * as fs from "fs";
import * as path from "path";

function createClient() {
  const credential = new Credential.default();
  const config = new OpenApi.Config({
    credential,
    endpoint: "esa.cn-hangzhou.aliyuncs.com",
    userAgent: "AlibabaCloud-Agent-Skills/alibabacloud-esa-pages-deploy",
    readTimeout: 60000,
    connectTimeout: 30000,
  });
  return new Esa20240910.default(config);
}

async function ensureServiceEnabled(client) {
  try {
    const status = await client.getErService(new Esa20240910.GetErServiceRequest({}));
    if (status.body?.status === "online" || status.body?.status === "Running") return;
  } catch (e) {
    // Ignore check errors, attempt to enable
  }
  console.log("Enabling Edge Routine service...");
  try {
    await client.openErService(new Esa20240910.OpenErServiceRequest({}));
    console.log("Edge Routine service enabled.");
  } catch (e) {
    if (e.code === "ErService.HasOpened" || e.message?.includes("HasOpened")) return;
    throw e;
  }
}

// 删除代码版本，用于回收未被使用的版本
async function deleteCodeVersion(client, name, codeVersion) {
  await client.deleteRoutineCodeVersion(
    new Esa20240910.DeleteRoutineCodeVersionRequest({ name, codeVersion })
  );
}

// 清理历史遗留的 Init 版本：这类版本由上传中断产生，永远不会被发布，却持续占用套餐配额。
// 只清理 30 分钟前的，避免误删正在进行的部署
async function pruneStaleVersions(client, name) {
  try {
    const res = await client.listRoutineCodeVersions(
      new Esa20240910.ListRoutineCodeVersionsRequest({ name })
    );
    const cutoff = Date.now() - 30 * 60 * 1000;
    const stale = (res.body?.codeVersions || []).filter((v) => {
      const created = Date.parse(v.createTime || "");
      return (
        String(v.status || "").toLowerCase() === "init" &&
        Number.isFinite(created) &&
        created < cutoff
      );
    });
    if (!stale.length) return;
    for (const v of stale) {
      try {
        await deleteCodeVersion(client, name, v.codeVersion);
        console.log(`Pruned stale code version ${v.codeVersion}.`);
      } catch (e) {
        console.warn(`Failed to prune ${v.codeVersion}: ${e.message}`);
      }
    }
  } catch (e) {
    console.warn(`Version pruning skipped: ${e.message}`);
  }
}

async function deployFolder(name, folderPath, description = "") {
  const client = createClient();
  const runtime = new TeaUtil.RuntimeOptions({});

  // 0. Ensure Edge Routine service is enabled
  await ensureServiceEnabled(client);

  // 0.1 回收历史遗留的 Init 版本，避免耗尽套餐的版本配额
  await pruneStaleVersions(client, name);

  // 1. Create routine
  console.log(`Creating routine: ${name}...`);
  try {
    await client.createRoutine(
      new Esa20240910.CreateRoutineRequest({ name, description })
    );
    console.log("Routine created.");
  } catch (e) {
    if (e.code === "RoutineNameAlreadyExist" || e.code === "RoutineAlreadyExist" || e.message?.includes("already exist")) {
      console.log("Routine already exists, continuing...");
    } else if (e.code === "Throttling.Api") {
      console.log("Throttled, retrying in 2 seconds...");
      await new Promise((r) => setTimeout(r, 2000));
      try {
        await client.createRoutine(
          new Esa20240910.CreateRoutineRequest({ name, description })
        );
        console.log("Routine created.");
      } catch (retryError) {
        if (retryError.code === "RoutineNameAlreadyExist" || retryError.code === "RoutineAlreadyExist") {
          console.log("Routine already exists, continuing...");
        } else {
          throw retryError;
        }
      }
    } else {
      throw e;
    }
  }

  // 2. Create assets code version
  console.log("Creating assets code version...");
  const params = new OpenApi.Params({
    action: "CreateRoutineWithAssetsCodeVersion",
    version: "2024-09-10",
    protocol: "https",
    method: "POST",
    authType: "AK",
    bodyType: "json",
    reqBodyType: "json",
    style: "RPC",
    pathname: "/",
  });
  const body = { Name: name, CodeDescription: description };
  const request = new OpenApi.OpenApiRequest({ body });
  const result = await client.callApi(params, request, runtime);
  const ossConfig = result.body?.OssPostConfig || {};
  const codeVersion = result.body?.CodeVersion;
  console.log(`Code version: ${codeVersion}`);

  // 3. Package and upload zip
  console.log("Packaging files...");
  const zip = new JSZip();
  let fileCount = 0;

  const addFiles = (dir, zipPath = "") => {
    for (const file of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, file);
      const zipFilePath = zipPath ? `${zipPath}/${file}` : file;
      if (fs.statSync(fullPath).isDirectory()) {
        addFiles(fullPath, zipFilePath);
      } else {
        zip.file(`assets/${zipFilePath}`, fs.readFileSync(fullPath));
        fileCount++;
      }
    }
  };
  addFiles(folderPath);
  console.log(`Packaged ${fileCount} files.`);

  const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
  console.log(`Zip size: ${(zipBuffer.length / 1024).toFixed(1)} KB`);

  // 每次重试都需要重新构造表单，避免复用已消费的请求体
  const buildUploadForm = () => {
    const formData = new FormData();
    formData.append("OSSAccessKeyId", ossConfig.OSSAccessKeyId);
    formData.append("Signature", ossConfig.Signature);
    formData.append("policy", ossConfig.Policy);
    formData.append("key", ossConfig.Key);
    if (ossConfig.XOssSecurityToken) {
      formData.append("x-oss-security-token", ossConfig.XOssSecurityToken);
    }
    formData.append("file", new Blob([zipBuffer]));
    return formData;
  };

  console.log("Uploading to OSS...");
  // 上传用的 OSS policy 有效期约 5 分钟，重试总耗时必须压在有效期内，
  // 否则后续重试只会拿到 Policy expired。2 × 120s + 10s 退避 = 250s
  const uploadAttempts = 2;
  const uploadTimeoutMs = 120000;
  let uploadError = null;
  for (let attempt = 1; attempt <= uploadAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), uploadTimeoutMs);
    try {
      const res = await fetch(ossConfig.Url, {
        method: "POST",
        body: buildUploadForm(),
        signal: controller.signal,
      });
      if (res.ok) {
        console.log(`Upload done (attempt ${attempt}, HTTP ${res.status}).`);
        uploadError = null;
        break;
      }
      // 失败时 OSS 返回非 2xx 并附带 XML 错误体，读取后可定位原因
      const detail = (await res.text()).slice(0, 200).replace(/\s+/g, " ");
      uploadError = new Error(`HTTP ${res.status} ${detail}`);
    } catch (e) {
      uploadError = e;
    } finally {
      clearTimeout(timer);
    }
    console.warn(`Upload attempt ${attempt}/${uploadAttempts} failed: ${uploadError.message}`);
    if (attempt < uploadAttempts) {
      const waitMs = attempt * 5000;
      console.log(`Retrying in ${waitMs / 1000}s...`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  if (uploadError) {
    // 上传失败的版本永远不会被发布，留在云端只会白占配额，需即时回收
    try {
      await deleteCodeVersion(client, name, codeVersion);
      console.log(`Rolled back unused code version ${codeVersion}.`);
    } catch (e) {
      console.warn(`Failed to roll back code version ${codeVersion}: ${e.message}`);
    }
    throw new Error(
      `Upload to OSS failed after ${uploadAttempts} attempts: ${uploadError.message}`
    );
  }

  // 4. Wait for build ready
  console.log("Waiting for build...");
  for (let i = 0; i < 300; i++) {
    const infoParams = new OpenApi.Params({
      action: "GetRoutineCodeVersionInfo",
      version: "2024-09-10",
      protocol: "https",
      method: "GET",
      authType: "AK",
      bodyType: "json",
      reqBodyType: "json",
      style: "RPC",
      pathname: "/",
    });
    const info = await client.callApi(
      infoParams,
      new OpenApi.OpenApiRequest({
        query: { Name: name, CodeVersion: codeVersion },
      }),
      runtime
    );
    const status = (info.body?.Status || "").toLowerCase();
    if (status === "available") {
      console.log("Build ready.");
      break;
    }
    if (status && status !== "init") {
      throw new Error(`Build failed: ${status}`);
    }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 1000));
  }

  // 5. Deploy to production
  console.log(`Deploying to production...`);
  const deployParams = new OpenApi.Params({
    action: "CreateRoutineCodeDeployment",
    version: "2024-09-10",
    protocol: "https",
    method: "POST",
    authType: "AK",
    bodyType: "json",
    reqBodyType: "json",
    style: "RPC",
    pathname: "/",
  });
  await client.callApi(
    deployParams,
    new OpenApi.OpenApiRequest({
      query: {
        Name: name,
        Env: "production",
        Strategy: "percentage",
        CodeVersions: JSON.stringify([
          { Percentage: 100, CodeVersion: codeVersion },
        ]),
      },
    }),
    runtime
  );

  // 6. Get access URL with token
  const routine = await client.getRoutine(
    new Esa20240910.GetRoutineRequest({ name })
  );
  let url = routine.body.defaultRelatedRecord
    ? `https://${routine.body.defaultRelatedRecord}`
    : null;

  // Get access token and append to URL
  if (url) {
    console.log("Getting access token...");
    const tokenParams = new OpenApi.Params({
      action: "GetRoutineAccessToken",
      version: "2024-09-10",
      protocol: "https",
      method: "GET",
      authType: "AK",
      bodyType: "json",
      reqBodyType: "json",
      style: "RPC",
      pathname: "/",
    });
    const tokenRes = await client.callApi(
      tokenParams,
      new OpenApi.OpenApiRequest({
        query: { Name: name },
      }),
      runtime
    );
    const token = tokenRes.body?.Token;
    if (token) {
      url += `?esa_er_token=${token}`;
      console.log("⏰ Token is valid for 1 hour");
    }
  }

  return url;
}

// Validate name format
function validateName(name) {
  // Must be lowercase letters/numbers/hyphens, start with letter, length >= 2
  const pattern = /^[a-z][a-z0-9-]{1,}$/;
  if (!pattern.test(name)) {
    throw new Error(
      `Invalid name "${name}". Must start with lowercase letter, contain only lowercase letters/numbers/hyphens, and be at least 2 characters long.`
    );
  }
}

// CLI
const [, , name, folderPath, description] = process.argv;

if (!name || !folderPath) {
  console.log("Usage: node scripts/deploy-folder.mjs <name> <folder-path> [description]");
  console.log("  name: Function name (lowercase, letters/numbers/hyphens, start with letter)");
  console.log("  folder-path: Path to static directory (e.g., ./dist)");
  console.log("  description: Optional description");
  process.exit(1);
}

validateName(name);

if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
  console.error(`Error: "${folderPath}" is not a valid directory.`);
  process.exit(1);
}

deployFolder(name, folderPath, description || "")
  .then((url) => {
    console.log("\n✅ Deployment successful!");
    console.log(`Access URL: ${url}`);
    console.log("\n💡 Note: If you access the link too quickly, DNS resolution may not have taken effect yet. Please wait a moment and try again.");
  })
  .catch((err) => {
    console.error("\n❌ Deployment failed:", err.message);
    process.exit(1);
  });
