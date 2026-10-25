// Main.Version from DLS.Game.Main
export class Version {
	constructor(
		readonly Major: number,
		readonly Minor: number,
		readonly Patch: number,
	) {}

	ToInt(): number {
		return this.Major * 100000 + this.Minor * 1000 + this.Patch;
	}

	static Parse(versionString: string): Version {
		const parts = versionString.split(".");
		const nums = parts.slice(0, 3).map((p) => {
			if (!/^\s*-?\d+\s*$/.test(p)) throw new Error("Invalid version: " + versionString);
			return parseInt(p, 10);
		});
		if (nums.length !== 3) throw new Error("Invalid version: " + versionString);
		return new Version(nums[0], nums[1], nums[2]);
	}

	static TryParse(versionString: string | null | undefined): Version | null {
		try {
			return Version.Parse(versionString ?? "");
		} catch {
			return null;
		}
	}

	toString(): string {
		return `${this.Major}.${this.Minor}.${this.Patch}`;
	}
}

export const DLSVersion = new Version(2, 1, 6);
export const DLSVersion_EarliestCompatible = new Version(2, 0, 0);
export const LastUpdatedString = "5 May 2025";
