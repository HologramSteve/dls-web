//! Chip descriptions as sent by the main thread (SimChipDesc in SimChip.ts) and modification commands
//! (SimModifyCommand in Simulator.ts). JSON field names match the TypeScript side.
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::hash::BuildHasherDefault;
use std::rc::Rc;

/// HashMap/HashSet with a deterministic hasher (std's randomized hasher isn't available on wasm32-unknown-unknown)
pub type FMap<K, V> = HashMap<K, V, BuildHasherDefault<Fnv>>;
pub type FSet<K> = HashSet<K, BuildHasherDefault<Fnv>>;

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct PinAddress {
	#[serde(rename = "PinID")]
	pub pin_id: i64,
	#[serde(rename = "PinOwnerID")]
	pub owner_id: i64,
}

#[derive(Deserialize, Clone, Debug)]
pub struct WireDesc {
	#[serde(rename = "Source")]
	pub source: PinAddress,
	#[serde(rename = "Target")]
	pub target: PinAddress,
}

#[derive(Deserialize, Clone, Debug)]
pub struct SubChipDesc {
	#[serde(rename = "Name")]
	pub name: String,
	#[serde(rename = "ID")]
	pub id: i64,
	#[serde(rename = "InternalData", default, deserialize_with = "de_u32_list")]
	pub internal_data: Option<Vec<u32>>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct SimChipDesc {
	#[serde(rename = "Name")]
	pub name: String,
	#[serde(rename = "ChipType")]
	pub chip_type: u8,
	#[serde(rename = "InputPinIDs")]
	pub input_ids: Vec<i64>,
	#[serde(rename = "OutputPinIDs")]
	pub output_ids: Vec<i64>,
	#[serde(rename = "InputPinBits", default)]
	pub input_bits: Vec<u8>,
	#[serde(rename = "OutputPinBits", default)]
	pub output_bits: Vec<u8>,
	#[serde(rename = "SubChips")]
	pub sub_chips: Vec<SubChipDesc>,
	#[serde(rename = "Wires")]
	pub wires: Vec<WireDesc>,
}

/// JS numbers (possibly negative int32 or > i32::MAX) to uint, like C#'s (uint) casts / JS `>>> 0`
fn de_u32_list<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Vec<u32>>, D::Error> {
	let v: Option<Vec<f64>> = Option::deserialize(d)?;
	Ok(v.map(|v| v.into_iter().map(|x| (x as i64) as u32).collect()))
}

#[derive(Deserialize, Debug)]
#[serde(tag = "type")]
pub enum Command {
	AddSubchip {
		target: Vec<i64>,
		#[serde(rename = "chipName")]
		chip_name: String,
		#[serde(rename = "subChipID")]
		sub_chip_id: i64,
		#[serde(rename = "internalData", default, deserialize_with = "de_u32_list")]
		internal_data: Option<Vec<u32>>,
	},
	RemoveSubChip {
		target: Vec<i64>,
		id: i64,
	},
	AddConnection {
		target: Vec<i64>,
		source: PinAddress,
		dest: PinAddress,
	},
	RemoveConnection {
		target: Vec<i64>,
		source: PinAddress,
		dest: PinAddress,
	},
	AddPin {
		target: Vec<i64>,
		#[serde(rename = "pinID")]
		pin_id: i64,
		#[serde(rename = "isInput")]
		is_input: bool,
	},
	RemovePin {
		target: Vec<i64>,
		#[serde(rename = "pinID")]
		pin_id: i64,
	},
	BuildRoot {
		desc: SimChipDesc,
	},
	SetInternalState {
		target: Vec<i64>,
		index: usize,
		value: f64,
	},
	UpdateInternalState {
		target: Vec<i64>,
		#[serde(deserialize_with = "de_u32_list")]
		data: Option<Vec<u32>>,
	},
	LibrarySet {
		descs: Vec<SimChipDesc>,
		#[serde(rename = "replaceAll")]
		replace_all: bool,
	},
	LibraryRemove {
		name: String,
	},
}

/// Library of chip descriptions (case-insensitive names, like NameKey on the TS side)
#[derive(Clone, Default)]
pub struct Library {
	map: FMap<String, Rc<SimChipDesc>>,
	hashes: std::cell::RefCell<FMap<String, u64>>,
}

pub fn name_key(name: &str) -> String {
	name.to_uppercase()
}

impl Library {
	pub fn set(&mut self, desc: SimChipDesc) {
		self.map.insert(name_key(&desc.name), Rc::new(desc));
		self.hashes.borrow_mut().clear();
	}
	pub fn remove(&mut self, name: &str) {
		self.map.remove(&name_key(name));
		self.hashes.borrow_mut().clear();
	}
	pub fn clear(&mut self) {
		self.map.clear();
		self.hashes.borrow_mut().clear();
	}
	pub fn get(&self, name: &str) -> Option<Rc<SimChipDesc>> {
		self.map.get(&name_key(name)).cloned()
	}

	/// Structural hash of a chip description including (recursively) all chips it contains.
	/// Instances remember the hash they were built from, so truth tables are never applied to an instance
	/// built from an older version of a description.
	pub fn desc_hash(&self, name: &str) -> u64 {
		self.desc_hash_depth(name, 0)
	}

	fn desc_hash_depth(&self, name: &str, depth: u32) -> u64 {
		let key = name_key(name);
		if let Some(&h) = self.hashes.borrow().get(&key) {
			return h;
		}
		let Some(d) = self.map.get(&key) else { return 0 };
		if depth > 64 {
			return 0;
		}
		let mut h = Fnv::new();
		h.str(&key);
		h.u64(d.chip_type as u64);
		for (ids, bits) in [(&d.input_ids, &d.input_bits), (&d.output_ids, &d.output_bits)] {
			h.u64(ids.len() as u64);
			for &id in ids.iter() {
				h.u64(id as u64);
			}
			for &b in bits.iter() {
				h.u64(b as u64);
			}
		}
		for s in &d.sub_chips {
			h.u64(s.id as u64);
			let sub = self.desc_hash_depth(&s.name, depth + 1);
			if sub == 0 {
				return 0;
			}
			h.u64(sub);
			if let Some(data) = &s.internal_data {
				h.u64(data.len() as u64);
				for &x in data {
					h.u64(x as u64);
				}
			}
		}
		for w in &d.wires {
			h.u64(w.source.owner_id as u64);
			h.u64(w.source.pin_id as u64);
			h.u64(w.target.owner_id as u64);
			h.u64(w.target.pin_id as u64);
		}
		let v = h.finish().max(1);
		self.hashes.borrow_mut().insert(key, v);
		v
	}
}

/// FNV-1a hasher (no dependency on std's randomized hasher, which is unavailable on wasm32-unknown-unknown)
pub struct Fnv(u64);
impl Fnv {
	pub fn new() -> Self {
		Fnv(0xcbf29ce484222325)
	}
	pub fn u64(&mut self, v: u64) {
		for b in v.to_le_bytes() {
			self.0 ^= b as u64;
			self.0 = self.0.wrapping_mul(0x100000001b3);
		}
	}
	pub fn str(&mut self, s: &str) {
		for b in s.bytes() {
			self.0 ^= b as u64;
			self.0 = self.0.wrapping_mul(0x100000001b3);
		}
		self.u64(s.len() as u64);
	}
	pub fn finish(&self) -> u64 {
		self.0
	}
}
impl std::hash::Hasher for Fnv {
	fn finish(&self) -> u64 {
		self.0
	}
	fn write(&mut self, bytes: &[u8]) {
		for &b in bytes {
			self.0 ^= b as u64;
			self.0 = self.0.wrapping_mul(0x100000001b3);
		}
	}
}
impl Default for Fnv {
	fn default() -> Self {
		Self::new()
	}
}
