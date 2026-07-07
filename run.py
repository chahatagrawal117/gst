import csv
from datetime import datetime
# just do the export of order from shopify and mention the file path and then it will generate all orders list in specific response
def check_each_Value(value):
    for key, key_value in value.items():
        if key_value is None or key_value == "":
            return False
        if key == "Total Transaction Value" and ((float)(key_value) < 10.00):
            return False
    return True

# helper function to normalize and parse dates
def parse_date(date_str):
    # replace dots with dashes (30.5.25 → 30-5-25)
    date_str = date_str.replace('.', '-')
    parts = date_str.split('-')

    # handle 2-digit year (e.g. 25 → 2025)
    if len(parts[-1]) == 2:
        parts[-1] = '20' + parts[-1]

    # zero-pad day and month if needed
    parts = [p.zfill(2) for p in parts]

    return datetime.strptime('-'.join(parts), "%d-%m-%Y")

def main():
    input_file = "/Users/chahat/code/gst/orders_export_7.csv"
    new_file_list = []

    with open(input_file, 'r') as infile:
        reader = csv.DictReader(infile)
        header = reader.fieldnames

        print("Header:", header)
        for row in reader:
            # Print data for each row
            # row is a dictionary
            invoice_no = row["Name"]
            invoice_no = invoice_no.replace("#","")
            paid_time = row["Paid at"]
            paid_time = paid_time.split(" ")[0]
            total_invoice_value = row["Total"]
            name_of_person = row["Billing Name"]
            billing_state = row["Billing Province"]

            # Parse the date string into a datetime object
            # print(paid_time)
            formatted_date_paid_time = paid_time
            if paid_time:
                date_object = datetime.strptime(paid_time, "%Y-%m-%d")

                # Convert the datetime object to the desired format
                formatted_date_paid_time = date_object.strftime("%d-%m-%Y")
            new_row_dict = {
                "Invoice Date": formatted_date_paid_time,
                "Invoice Number": invoice_no,
                "Customer Billing Name": name_of_person,
                "Customer Billing GSTIN": "-",
                "Supply State": billing_state,
                "HSN": 4909,
                "Total Transaction Value": total_invoice_value
            }
            if not check_each_Value(new_row_dict):
                continue
            total_invoice_value = float(total_invoice_value)
            taxable_value = float(total_invoice_value) / 1.18
            taxable_value = round(taxable_value, 2)

            total_tax = total_invoice_value - taxable_value

            cgst = 0
            sgst = 0
            igst = 0
            if billing_state == "RJ":
                cgst = total_tax / 2
                cgst = round(cgst, 2)
                sgst = cgst
            else:
                igst = total_tax
                igst = round(igst, 2)

            new_row_dict["Item Taxable Value"] = taxable_value
            new_row_dict["CGST"] = cgst
            new_row_dict["SGST"] = sgst
            new_row_dict["IGST"] = igst
            new_file_list.append(new_row_dict)
    return new_file_list


new_list_data = main()
# removing some values from final dataa
final_data_record = []
for i in new_list_data:
    # if float(i["Total Transaction Value"]) > 5000.00:
    #     continue
    final_data_record.append(i)

new_list_data=final_data_record

heading = ["Invoice Date", "Invoice Number", "Customer Billing Name", "Customer Billing GSTIN", "Supply State",
           "HSN", "Item Taxable Value", "CGST", "SGST", "IGST", "Total Transaction Value"]



# take offline bills also
input_offline_bill_sheet = "/Users/chahat/code/gst/temp_offline_sheet_download_1 - Sheet1.csv"
# create a new sheet for offline old bills:
output_offline_bill_sheet = "output_offline_18_apr10.csv"

output_csv_file = 'output_18_apr10.csv'


temp_no = 0
# Read offline bills, compute tax the same way as online, and append to new_list_data.
# (all_dates_orders is built later, in one pass over new_list_data, to avoid
#  double-counting offline entries.)

with open(input_offline_bill_sheet, newline='') as f:
    reader = csv.DictReader(f)
    for row in reader:
        date_value = row['Date'].strip()
        if date_value:  # make sure it's not empty
            temp_no+=1

            date_object = datetime.strptime(date_value, "%d.%m.%y")

            # Convert the datetime object to the desired format
            formatted_date_paid_time = date_object.strftime("%d-%m-%Y")
            total_invoice_value = row['Total'].strip()
            new_row_dict = {
                "Invoice Date": formatted_date_paid_time,
                "Invoice Number": temp_no,
                "Customer Billing Name": row['Party'].strip(),
                "Customer Billing GSTIN": row['GSTIN'].strip(),
                "Supply State": "-",
                "HSN": 4909,
                "Total Transaction Value": total_invoice_value,
            }
            total_invoice_value = float(total_invoice_value)
            taxable_value = float(total_invoice_value) / 1.18
            taxable_value = round(taxable_value, 2)

            total_tax = total_invoice_value - taxable_value

            cgst = 0
            sgst = 0
            igst = 0
            igst = total_tax
            igst = round(igst, 2)

            new_row_dict["Item Taxable Value"] = taxable_value
            new_row_dict["CGST"] = cgst
            new_row_dict["SGST"] = sgst
            new_row_dict["IGST"] = igst
            new_list_data.append(new_row_dict)


new_list_data.sort(key=lambda x: parse_date(x['Invoice Date']))

# Build all_dates_orders from scratch to avoid double-counting offline entries.
# (Previously offline entries were added once inside the offline CSV loop and
#  again in the loop below, causing each offline order to consume 2 invoice
#  numbers instead of 1.)
all_dates_orders = [
    {"date": i["Invoice Date"], "invoice_no": i["Invoice Number"]}
    for i in new_list_data
]
all_dates_orders.sort(key=lambda x: parse_date(x['date']))

starting_invoice_no = 501

for i, bill in enumerate(all_dates_orders, start=starting_invoice_no):
    bill['new_invoice_no'] = str(i)
invoice_map = {b['invoice_no']: b['new_invoice_no'] for b in all_dates_orders}


with open(input_offline_bill_sheet, newline='') as infile, open(output_offline_bill_sheet, 'w', newline='') as outfile:
    reader = csv.DictReader(infile)
    fieldnames = reader.fieldnames
    writer = csv.DictWriter(outfile, fieldnames=fieldnames)
    writer.writeheader()
    # Advance temp_no only for rows that were actually numbered in the first loop
    # (i.e. rows with a non-empty Date), so blank/skipped rows don't misalign
    # every subsequent row's invoice number.
    temp_no = 0
    for row in reader:
        if row['Date'].strip():
            temp_no += 1
            if temp_no in invoice_map:
                row['Invoice No.'] = invoice_map[temp_no]
        writer.writerow(row)

# now give  new invoice no for website orders

with open(output_csv_file, 'w', newline='') as outfile:
    writer = csv.writer(outfile)
    writer.writerow(heading)
    total_tax =0.0
    for i in range(0, len(new_list_data)):
        new_row = []
        for head in heading:
            if head == "Invoice Number":
                old_invoice_no = new_list_data[i][head]
                new_invoice_no = invoice_map[old_invoice_no]
                new_row.append(new_invoice_no)
            else:
                new_row.append(new_list_data[i][head])
        total_tax += (float)(new_list_data[i]["Total Transaction Value"])-(float)(new_list_data[i]["Item Taxable Value"])
        writer.writerow(new_row)
    print("TOTAL TAX: ", total_tax)

