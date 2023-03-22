erpnext.utils.PickListScanner = class PickListScanner {
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

		this.items_table_name = opts.items_table_name || "locations";
		this.items_table = this.frm.doc[this.items_table_name];

		// optional sound name to play when scan either fails or passes.
		// see https://frappeframework.com/docs/v14/user/en/python-api/hooks#sounds
		this.success_sound = opts.play_success_sound;
		this.fail_sound = "error";
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
				item_code: `XX${this.scan_barcode_field.value.substring(0, 6)}`,
				serial_no: this.scan_barcode_field.value
			}

			this.get_row_to_modify_on_scan(serial_no_input.item_code, serial_no_input.serial_no, (r) => {
				if (!r || Object.keys(r).length === 0) {
					this.show_alert(__("Cannot find Item"), "red");
					this.clean_up();
					this.play_fail_sound();
					reject();
					return;
				}

        this.show_alert(__("Pick Item"), "green");

				me.update_table(r).then(row => {
					this.play_success_sound();
					resolve(row);
				}).catch(() => {
					this.play_fail_sound();
					reject();
				});
			});
		});
	}

	update_table(row) {
		return new Promise(resolve => {
			frappe.run_serially([
				() => this.set_item(row),
				() => this.clean_up(),
				() => resolve(row)
			]);
		});
	}

	set_item(row) {
		return new Promise(resolve => {
			const increment = async (value = 1) => {
				item_data[this.qty_field] = Number((row[this.qty_field] || 0)) + Number(value);
				await frappe.model.set_value(row.doctype, row.name, item_data);
				return value;
			};

			increment().then((value) => resolve(value));
		});
	}

	show_scan_message(idx, exist = null, qty = 1) {
		// show new row or qty increase toast
		if (exist) {
			this.show_alert(__("Row #{0}: Qty increased by {1}", [idx, qty]), "green");
		} else {
			this.show_alert(__("Row #{0}: Item added", [idx]), "green")
		}
	}

	get_row_to_modify_on_scan(item_code, serial_no, callback) {
		const matching_row = (row) => {
			return row.item_code == item_code
				&& row[this.serial_no_field]?.includes(serial_no);
		}

		callback(this.items_table.find(matching_row));
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