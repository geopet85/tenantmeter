# Install and run

Use Node.js 22 LTS to match this repository's `.nvmrc`. CI also tests Node.js 24 LTS. npm comes with Node; do not install npm separately. No AWS credentials are needed to build or run the demo.

## macOS

1. Open the [official Node.js download page](https://nodejs.org/en/download).
2. Select Node.js 22 LTS, macOS, and the `.pkg` installer.
3. Run the installer and keep its default options.
4. Close and reopen Terminal, then run the version checks below.

If you already use nvm, run `nvm install 22` and `nvm use 22` instead of installing another copy.

## Windows

1. Open the [official Node.js download page](https://nodejs.org/en/download).
2. Select Node.js 22 LTS, Windows, and the `.msi` installer. Choose x64 for Intel/AMD or ARM64 for an ARM device.
3. Run the installer. Keep npm and the option to add Node to PATH enabled.
4. Close and reopen PowerShell, then run the version checks below.

Use single-line CLI commands in PowerShell. The backslash line continuations in POSIX examples do not work there. For credentials, use `$env:AWS_PROFILE='your-profile'` rather than `export AWS_PROFILE=...`.

## Linux, macOS with nvm, or WSL

You need bash, curl, and internet access. Install missing tools through your OS package manager. Use the [nvm installation instructions](https://github.com/nvm-sh/nvm#installing-and-updating); the installer command is:

```sh
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash
```

Close and reopen your terminal so its shell profile loads nvm. Then run:

```sh
command -v nvm
nvm install 22
nvm use 22
nvm alias default 22
```

After cloning, `nvm install` and `nvm use` from the repository root read `.nvmrc`. nvm above is for POSIX shells, including WSL; use the Windows installer for native PowerShell.

## Check the installation

```sh
node --version
npm --version
node -p "process.execPath"
```

Node should print `v22.x.x` or `v24.x.x`; npm should print a version number. The last command shows which Node executable this terminal uses.

## Get the source and build

With Git installed:

```sh
git clone https://github.com/geopet85/tenantmeter.git
cd tenantmeter/packages/cli
npm ci
npm run check
node dist/tenantmeter.js demo
```

Without Git, open the [repository](https://github.com/geopet85/tenantmeter), select **Code → Download ZIP**, extract it, and open a terminal in `tenantmeter-main/packages/cli`. Run the last three commands above. Do not run them from inside the ZIP viewer.

`npm ci` installs the locked dependencies; its first run needs registry access. `npm run check` checks types, runs offline tests, and builds `dist/tenantmeter.js`. The demo prints 2,505 objects and 5,501,000,000 bytes. It saves a local checkpoint under `.tenantmeter-state/`.

Run commands from `packages/cli`, for example `node dist/tenantmeter.js --help`. The npm package is not published. To add a global `tenantmeter` command, see [local tarball installation](README.md#install-from-this-checkout).

## Fix common setup errors

| Error | What to do |
| --- | --- |
| `node` or `npm` not found | Reopen the terminal after installation. On macOS/Linux run `command -v node`; on PowerShell run `Get-Command node`. Repair the installer/PATH if no executable appears. |
| Node prints v20 or older | With nvm, run `nvm install 22` then `nvm use 22` in this terminal. Otherwise install Node 22 LTS and reopen the terminal. Check `node -p "process.execPath"` for an older installation earlier in PATH. |
| `nvm: command not found` | Reopen the terminal. Follow nvm's shell-profile troubleshooting at its installation link above if it is still missing. |
| PowerShell blocks `npm.ps1` | Run `npm.cmd ci` and `npm.cmd run check`. You can use `npm.cmd` wherever these docs say `npm`. |
| Cannot find `package.json` | Change into the extracted repository's `packages/cli` directory before running npm. |
| Cannot find `dist/tenantmeter.js` | Run `npm run build` from `packages/cli`. |
| Global install fails with `EACCES` | Run the local build with `node dist/tenantmeter.js`, or use a Node version manager for a user-owned install. Do not use `sudo npm install`. |
| esbuild platform/binary error | Run `npm ci` on the machine where you will build. Do not copy `node_modules` between operating systems or architectures. |
| Registry/network error | Check internet access and `npm config get registry`. Use your organization's required proxy/registry settings. Keep TLS verification enabled. |

For cloud credentials, bucket permissions, mapping, limits, and resume commands, continue with the [CLI instructions](README.md). Building and running the demo does not verify access to a cloud bucket.
