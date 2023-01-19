erpnext.utils.SerialNoScanner = class SerialNoScanner {
	constructor(opts) {
		this.frm = opts.frm;

		// field from which to capture input of scanned data
		this.scan_field_name = opts.scan_field_name || "scan_serial_no";
		this.scan_barcode_field = this.frm.fields_dict[this.scan_field_name];

		//current warehouse field
		this.scan_warehouse_name = opts.scan_field_name || "current_warehouse";
		this.scan_warehouse_field = this.frm.fields_dict[this.scan_warehouse_name];

		//item warehouse field
		this.warehouse_field = opts.warehouse_field || "warehouse";
		this.barcode_field = opts.barcode_field || "barcode";
		this.serial_no_field = opts.serial_no_field || "serial_no";
		this.batch_no_field = opts.batch_no_field || "batch_no";
		this.uom_field = opts.uom_field || "uom";
		this.qty_field = opts.qty_field || "qty";

		this.items_table_name = opts.items_table_name || "items";
		this.items_table = this.frm.doc[this.items_table_name];

		// optional sound name to play when scan either fails or passes.
		// see https://frappeframework.com/docs/v14/user/en/python-api/hooks#sounds
		this.success_sound = opts.play_success_sound;
		this.fail_sound = "error";

		// any API that takes `search_value` as input and returns dictionary as follows
		// {
		//     item_code: "HORSESHOE", // present if any item was found
		//     bar_code: "123456", // present if barcode was scanned
		//     batch_no: "LOT12", // present if batch was scanned
		//     serial_no: "987XYZ", // present if serial no was scanned
		//     uom: "Kg", // present if barcode UOM is different from default
		// }
		this.scan_api = opts.scan_api || "erpnext.stock.utils.scan_barcode";
	}

	process_scan() {
		return new Promise((resolve, reject) => {
			let me = this;

			const input = this.scan_barcode_field.value;
			this.scan_barcode_field.set_value("");
			if (!input) {
				return;
			}

			if (input.length < 20) {
				this.show_alert(__("Serial No not scanned"), "red");
				this.clean_up();
				this.play_fail_sound();
				reject();
				return;
			}

			const serial_no_input = {
				item_code: this.scan_barcode_field.value.substring(0, 6),
				serial_no: this.scan_barcode_field.value
			}

			this.scan_api_call(serial_no_input.item_code, (r) => {
				const data = r && r.message;
				if (!data || Object.keys(data).length === 0) {
					this.show_alert(__("Cannot find Item"), "red");
					this.clean_up();
					this.play_fail_sound();
					reject();
					return;
				}

				data.serial_no = serial_no_input.serial_no;

				me.update_table(data).then(row => {
					this.play_success_sound();
					resolve(row);
				}).catch(() => {
					this.play_fail_sound();
					reject();
				});
			});
		});
	}

	scan_api_call(input, callback) {
		frappe
			.call({
				method: this.scan_api,
				args: {
					search_value: input,
				},
			})
			.then((r) => {
				callback(r);
			});
	}

	update_table(data) {
		return new Promise(resolve => {
			let cur_grid = this.frm.fields_dict[this.items_table_name].grid;

			const { item_code, barcode, batch_no, serial_no, uom } = data;

			if (this.is_duplicate_serial_no(item_code, serial_no)) {
				this.clean_up();
				reject();
				return;
			}

			let row = this.get_row_to_modify_on_scan(item_code, batch_no, uom, barcode);

			this.is_new_row = false;
			if (!row) {
				this.is_new_row = true;

				// add new row if new item/batch is scanned
				row = frappe.model.add_child(this.frm.doc, cur_grid.doctype, this.items_table_name);
				// trigger any row add triggers defined on child table.
				this.frm.script_manager.trigger(`${this.items_table_name}_add`, row.doctype, row.name);
				this.frm.has_items = false;
			}

			frappe.run_serially([
				() => this.set_item(row, item_code, barcode, batch_no, serial_no).then(qty => {
					this.show_scan_message(row.idx, row.item_code, qty);
				}),
				() => this.clean_up(),
				() => resolve(row)
			]);
		});
	}

	set_item(row, item_code, barcode, batch_no, serial_no) {
		return new Promise(resolve => {
			const increment = async (value = 1) => {
				const new_serial_nos = this.get_serial_no(row, serial_no);
				const item_data = { item_code: item_code, serial_no: new_serial_nos };
				item_data[this.warehouse_field] = this.scan_warehouse_field.value;
				item_data[this.qty_field] = Number((row[this.qty_field] || 0)) + Number(value);
				console.log('>>', item_data);
				await frappe.model.set_value(row.doctype, row.name, item_data);
				return value;
			};

			increment().then((value) => resolve(value));
		});
	}

	async set_serial_no(row, serial_no) {
		if (serial_no && frappe.meta.has_field(row.doctype, this.serial_no_field)) {
			const existing_serial_nos = row[this.serial_no_field];
			let new_serial_nos = "";

			if (!!existing_serial_nos) {
				new_serial_nos = existing_serial_nos + "\n" + serial_no;
			} else {
				new_serial_nos = serial_no;
			}
			await frappe.model.set_value(row.doctype, row.name, this.serial_no_field, new_serial_nos);
		}
	}

	get_serial_no(row, serial_no) {
		if (serial_no && frappe.meta.has_field(row.doctype, this.serial_no_field)) {
			const existing_serial_nos = row[this.serial_no_field];
			let new_serial_nos = "";

			if (!!existing_serial_nos) {
				new_serial_nos = existing_serial_nos + "\n" + serial_no;
			} else {
				new_serial_nos = serial_no;
			}

			return new_serial_nos;
		}
	}

	async set_barcode_uom(row, uom) {
		if (uom && frappe.meta.has_field(row.doctype, this.uom_field)) {
			await frappe.model.set_value(row.doctype, row.name, this.uom_field, uom);
		}
	}

	async set_batch_no(row, batch_no) {
		if (batch_no && frappe.meta.has_field(row.doctype, this.batch_no_field)) {
			await frappe.model.set_value(row.doctype, row.name, this.batch_no_field, batch_no);
		}
	}

	show_scan_message(idx, exist = null, qty = 1) {
		// show new row or qty increase toast
		if (exist) {
			this.show_alert(__("Row #{0}: Qty increased by {1}", [idx, qty]), "green");
		} else {
			this.show_alert(__("Row #{0}: Item added", [idx]), "green")
		}
	}

	// is_duplicate_serial_no(row, serial_no) {
	// 	if (!row) return false;

	// 	const is_duplicate = row[this.serial_no_field]?.includes(serial_no);

	// 	if (is_duplicate) {
	// 		this.show_alert(__("Serial No {0} is already added", [serial_no]), "orange");
	// 	}
	// 	return is_duplicate;
	// }

	get_row_to_modify_on_scan(item_code, batch_no, uom, barcode) {
		const matching_row = (row) => {
			const item_match = row.item_code == item_code;
			const warehouse_match = row[this.warehouse_field] == this.scan_warehouse_field.value;

			return item_match
				&& warehouse_match
		}

		return this.items_table.find(matching_row) || this.get_existing_blank_row();
	}

	is_duplicate_serial_no(item_code, serial_no) {
		const matching_row = (row) => {
			return row.item_code == item_code
				&& row[this.serial_no_field]?.includes(serial_no);
		}

		if (this.items_table.find(matching_row)) {
			this.show_alert(__("Serial No {0} is already added", [serial_no]), "orange");
			return true;
		}

		return false;
	}

	get_existing_blank_row() {
		return this.items_table.find((d) => !d.item_code);
	}

	play_success_sound() {
		this.success_sound && frappe.utils.play_sound(this.success_sound);
	}

	play_fail_sound() {
		this.fail_sound && frappe.utils.play_sound(this.fail_sound);
	}

	clean_up() {
		this.scan_barcode_field.set_value("");
		refresh_field(this.items_table_name);
	}
	show_alert(msg, indicator, duration = 3) {
		frappe.show_alert({ message: msg, indicator: indicator }, duration);
	}
};