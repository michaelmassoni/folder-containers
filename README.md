# Folder Containers (Firefox Extension)

Automatically open bookmarks from specific folders in their assigned Firefox Containers.

## Features
- **Context Menu Integration**: Right-click any bookmark folder to assign it to a Container.
- **Automatic Switching**: Opening a bookmark from a mapped folder automatically re-opens the tab in the correct Container.
- **Privacy Focused**: No data collection. All configurations are stored locally.

## Installation
1. Download the latest release.
2. Open Firefox and navigate to `about:addons`.
3. Click the gear icon > "Install Add-on From File...".
4. Select the `.zip` or `.xpi` file.

## Development
This extension uses the WebExtensions API.
- **Manifest**: V2 (compatible with Firefox 57+)
- **Permissions**: `contextualIdentities`, `bookmarks`, `webNavigation`, `tabs`

## License
[GPLv3](LICENSE)
