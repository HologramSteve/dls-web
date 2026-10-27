// Live collaboration flags read by the ported game code (web-only addition; kept dependency-free to avoid import cycles)
export const CollabState = {
	// The local user is a viewer in a room: the edited chip can't be changed
	ReadOnly: false,
	// The open project was shared with the local user as a viewer (accounts / cloud storage)
	CloudReadOnly: (): boolean => false,
};
