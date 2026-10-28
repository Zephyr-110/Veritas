use crate::SERVICE_FEE;

pub fn get_amount(output_pool_amount: u64, input_pool_amount: u64, amount_in: u64) -> u64 {
    (output_pool_amount as u128)
        .checked_sub(
            (output_pool_amount as u128)
                .checked_mul(input_pool_amount as u128)
                .unwrap()
                .checked_div(
                    (input_pool_amount as u128)
                        .checked_add(
                            (amount_in as u128)
                                .checked_mul(
                                    (10000 - SERVICE_FEE) as u128
                                )
                                .unwrap()
                                .checked_div(10000u128)
                                .unwrap()
                        )
                        .unwrap())
                .unwrap())
        .unwrap() as u64
}