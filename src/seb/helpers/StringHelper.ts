// Port of Seb.Helpers.StringHelper (the "NonAlloc" char-buffer variants just return strings in JS)
export function SplitByLine(text: string, removeEmptyEntries = false): string[] {
	const lines = text.split(/\r\n|\r|\n/);
	return removeEmptyEntries ? lines.filter((l) => l.length > 0) : lines;
}

export function CreateBinaryString(value: number, removeLeadingZeroes = false): string {
	let binary = (value >>> 0).toString(2);
	if (!removeLeadingZeroes) {
		binary = binary.padStart(32, "0");
	} else {
		const paddedLength = Math.floor((binary.length + 7) / 8) * 8;
		binary = binary.padStart(paddedLength, "0");
	}
	const groups: string[] = [];
	for (let i = 0; i < binary.length / 8; i++) groups.push(binary.substring(i * 8, i * 8 + 8));
	return groups.join(" ");
}

export function CreateIntegerString(value: number): string {
	return String(value | 0);
}

export function CreateHexString(value: number, upperCase = true): string {
	const s = (value >>> 0).toString(16);
	return upperCase ? s.toUpperCase() : s;
}
