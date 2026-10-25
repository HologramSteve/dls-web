// Port of Seb.Types.Scope<T>: a pooled stack of scope objects.
// C# `using (scope) { ... }` blocks become explicit `scope.Dispose()` calls (usually in a finally block).
export class Scope<T> {
	private readonly pool: T[] = [];
	private readonly stack: T[] = [];
	private readonly factory: () => T;

	constructor(factory: () => T) {
		this.factory = factory;
	}

	get IsInsideScope(): boolean {
		return this.stack.length > 0;
	}

	get CurrentScope(): T {
		return this.stack[this.stack.length - 1];
	}

	CreateScope(): T {
		const scope = this.pool.length > 0 ? this.pool.pop()! : this.factory();
		this.stack.push(scope);
		return scope;
	}

	ExitScope(): void {
		const s = this.stack.pop();
		if (s !== undefined) this.pool.push(s);
	}

	TryGetCurrentScope(): T | undefined {
		return this.stack.length > 0 ? this.stack[this.stack.length - 1] : undefined;
	}
}

export interface IDisposable {
	Dispose(): void;
}

// Helper mirroring C# `using`: runs fn, then disposes (even if fn throws)
export function using<S extends IDisposable, R>(scope: S, fn: (s: S) => R): R {
	try {
		return fn(scope);
	} finally {
		scope.Dispose();
	}
}
