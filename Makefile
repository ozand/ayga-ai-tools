test:
	node --test test/artifact-dom-map.test.js

package:
	zip -r -FS extension.zip . -x "*.git*" "*.DS_Store" "extension.zip" "node_modules*" "test*"
